import { DurableObject } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

import { createRouter } from "./router";
import { trackResponseBody, type UpdateAbort } from "./stream-lifetime";
import { loadApp } from "./version-source";

type ScheduledAlarm = { name: string; time: number; token: string };

type AppConfig = { hash: string; generation: number; readOnly: boolean };
type VersionState = {
  current: AppConfig | null;
  pending: AppConfig | null;
  pendingSince?: number;
};
type SwapRow = {
  id: number;
  facet: string | null;
  oldHash: string | null;
  newHash: string;
  kind: "code" | "scope";
  pendingSince: number;
  swappedAt: number;
  forced: number;
  abortedStreams: number;
  restartCommit: number;
};

// This class stays stable; only the app facet's code is versioned.
export class Supervisor extends DurableObject<Env> {
  private state: VersionState;
  private swapping = false;
  private forceRequested = false;
  private bootstrapRead?: Promise<void>;
  private readonly restoring: Promise<void>;
  private readonly readyRequested = new Set<string>();
  private readonly runningAlarms = new Map<string, string>();
  private readonly active = new Map<AbortController, string>();
  private readonly streams = new Set<AbortController>();
  private drainTimer?: ReturnType<typeof setTimeout>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx.storage.kv.get<VersionState>("app-config") ?? { current: null, pending: null };
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS swaps (
        id INTEGER PRIMARY KEY,
        facet TEXT, oldHash TEXT, newHash TEXT NOT NULL, kind TEXT NOT NULL,
        pendingSince INTEGER NOT NULL, swappedAt INTEGER NOT NULL,
        forced INTEGER NOT NULL, abortedStreams INTEGER NOT NULL, restartCommit INTEGER NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS facets (
        name TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, loadedHash TEXT, loadedAt INTEGER NOT NULL, loadedReadOnly INTEGER NOT NULL DEFAULT 0,
        alarmTime INTEGER, alarmToken TEXT
      )
    `);
    // Inflight tracking cannot survive restart; finish any persisted pending swap on wake.
    this.restoring = this.swap(false, true);
  }

  private readonly router = createRouter<Env>()
    // Local diagnostics bypass update checks and admission.
    .get("/__status", (c) => {
      const raw = c.req.query("swaps") ?? "20";
      const limit = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit)) {
        return new Response("Invalid swaps", { status: 400 });
      }
      const swaps = this.ctx.storage.sql
        .exec<SwapRow>("SELECT * FROM swaps ORDER BY id DESC LIMIT ?", Math.min(limit, 100))
        .toArray()
        .map((row) => ({ ...row, forced: !!row.forced, restartCommit: !!row.restartCommit }));
      return Response.json({
        ...this.state,
        pendingSince: this.state.pendingSince ?? null,
        inflight: this.active.size,
        swapping: this.swapping,
        swaps,
        facets: this.ctx.storage.sql.exec("SELECT * FROM facets ORDER BY name").toArray(),
      });
    })
    .all("/__status", () => new Response("Method not allowed", { status: 405 }))
    // Local trusted control plane only; never forward scope requests to the facet.
    .put("/__scope", async (c) => {
      const body = await c.req.raw.json<{ readOnly?: unknown }>();
      if (typeof body.readOnly !== "boolean") return new Response("Invalid scope", { status: 400 });
      const target = this.target();
      if (!target) return new Response("Publish a version first", { status: 503 });
      // Same scope means same facet props; draining would only cost availability.
      if (target.readOnly === body.readOnly)
        return Response.json({ accepted: true, changed: false });
      this.stage({ ...target, readOnly: body.readOnly });
      return Response.json({ accepted: true });
    })
    .all("/__scope", () => new Response("Method not allowed", { status: 405 }))
    .all("*", (c) => {
      // Clients own retries; never retain requests while old bodies drain.
      if (this.needsSwap("app")) {
        return new Response("Update pending; retry later", {
          status: 503,
          headers: {
            "Retry-After": "1",
            "X-Current-Version": this.loaded("app")?.loadedHash ?? "",
            "X-Pending-Version": this.state.pending!.hash,
            "Cache-Control": "no-store",
          },
        });
      }
      if (!this.state.current) return new Response("Publish a version first", { status: 503 });
      return this.serve(c.req.raw);
    });

  async fetch(request: Request): Promise<Response> {
    await this.restoring;
    if (new URL(request.url).pathname !== "/__status") await this.bootstrap();
    return this.router.fetch(request, this.env);
  }

  // Keep each logical due time separate from the physical alarm's drain deferrals.
  async setAlarm(facet: string, time: number | Date): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        "UPDATE facets SET alarmTime = ?, alarmToken = ? WHERE name = ?",
        Number(time),
        crypto.randomUUID(),
        facet,
      );
      await this.rearm();
    });
  }

  getAlarm(facet: string): number | null {
    const [scheduled] = this.ctx.storage.sql
      .exec<ScheduledAlarm>(
        "SELECT name, alarmTime AS time, alarmToken AS token FROM facets WHERE name = ? AND alarmTime IS NOT NULL",
        facet,
      )
      .toArray();
    // Like native alarms, the running delivery is not a pending alarm.
    return scheduled && scheduled.token !== this.runningAlarms.get(facet) ? scheduled.time : null;
  }

  async deleteAlarm(facet: string): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        "UPDATE facets SET alarmTime = NULL, alarmToken = NULL WHERE name = ?",
        facet,
      );
      await this.rearm();
    });
  }

  private async rearm(retrying = false): Promise<void> {
    // Delivery rearms once after all handlers, preserving native retry metadata on failure.
    if (this.runningAlarms.size) return;
    const scheduled = this.ctx.storage.sql
      .exec<{ name: string; time: number }>(
        "SELECT name, alarmTime AS time FROM facets WHERE alarmTime IS NOT NULL",
      )
      .toArray();
    const times = scheduled.map(({ name, time }) =>
      this.needsSwap(name) ? Math.max(time, Date.now() + 2000) : time,
    );
    const time = times.length ? Math.min(...times) : null;
    // Leave an overdue, deliverable failed alarm to native retry to preserve metadata.
    if (retrying && time !== null && time <= Date.now()) return;
    if (time === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(time);
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    await this.restoring;
    await this.bootstrap();
    const due = this.ctx.storage.sql
      .exec<ScheduledAlarm>(
        "SELECT name, alarmTime AS time, alarmToken AS token FROM facets WHERE alarmTime <= ? ORDER BY alarmTime, name",
        Date.now(),
      )
      .toArray();
    const failures: unknown[] = [];
    for (const scheduled of due) {
      if (this.needsSwap(scheduled.name)) continue;
      // A preceding handler may cancel or replace another facet's wake-up.
      const [current] = this.ctx.storage.sql
        .exec<{ token: string | null }>(
          "SELECT alarmToken AS token FROM facets WHERE name = ?",
          scheduled.name,
        )
        .toArray();
      if (current?.token !== scheduled.token) continue;
      if (!this.state.current) throw new Error("Publish a version first");
      const { release } = this.beginWork(scheduled.name);
      this.runningAlarms.set(scheduled.name, scheduled.token);
      try {
        // 'alarm' is reserved on DO RPC; copy the runtime's non-serializable metadata.
        await this.facet(scheduled.name).dispatchAlarm(
          info && {
            scheduledTime: scheduled.time,
            retryCount: info.retryCount,
            isRetry: info.isRetry,
          },
        );
        // A rearm, even at the same time, must survive completion.
        this.ctx.storage.sql.exec(
          "UPDATE facets SET alarmTime = NULL, alarmToken = NULL WHERE name = ? AND alarmToken = ?",
          scheduled.name,
          scheduled.token,
        );
      } catch (error) {
        // Leave this row intact for native retry, but still deliver other facets.
        failures.push(error);
      } finally {
        this.runningAlarms.delete(scheduled.name);
        release();
      }
    }
    await this.rearm(failures.length > 0);
    if (failures.length) throw failures[0];
  }

  async pending(hash: string): Promise<boolean> {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return false;
    const latest: unknown = await this.env.VERSIONS.get("latest", "json");
    return this.acceptPublication(hash, latest);
  }

  private async bootstrap(): Promise<void> {
    if (this.state.current) return;
    this.bootstrapRead ??= (async () => {
      const latest: unknown = await this.env.VERSIONS.get("latest", "json");
      if (
        latest &&
        typeof latest === "object" &&
        "hash" in latest &&
        typeof latest.hash === "string"
      )
        await this.acceptPublication(latest.hash, latest);
    })().finally(() => {
      this.bootstrapRead = undefined;
    });
    await this.bootstrapRead;
  }

  private async acceptPublication(hash: string, latest: unknown): Promise<boolean> {
    if (latest === null || latest === undefined) return false;
    let config: AppConfig;
    try {
      if (
        typeof latest !== "object" ||
        !("hash" in latest) ||
        typeof latest.hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(latest.hash) ||
        !("generation" in latest) ||
        typeof latest.generation !== "number" ||
        !Number.isSafeInteger(latest.generation) ||
        latest.generation < 1
      )
        throw new Error("Invalid facet publication");
      if (latest.hash !== hash) throw new Error("Unpublished facet hash");
      const highest = Math.max(
        this.state.current?.generation ?? 0,
        this.state.pending?.generation ?? 0,
      );
      if (latest.generation <= highest) return this.state.pending?.hash === hash;
      const scope = {
        supervisorId: this.ctx.id.toString(),
        readOnly: this.target()?.readOnly ?? false,
      };
      await loadApp(this.env, latest.hash, scope, "app", true);
      // A scope change may land during preflight; never stage the stale permission.
      // The module is already validated, so the facet receives its current scope through props.
      const readOnly = this.target()?.readOnly ?? false;
      config = { hash: latest.hash, generation: latest.generation, readOnly };
    } catch (error) {
      console.error("Facet preflight failed; keeping current configuration", latest, error);
      return false;
    }
    const target = this.target();
    // Another facet may finish a newer preflight while this one awaits code.
    if (config.generation <= (target?.generation ?? 0)) return this.state.pending?.hash === hash;
    if (target?.hash === config.hash) {
      // A forced republication of identical code advances ordering, not the drain.
      target.generation = config.generation;
      this.ctx.storage.kv.put("app-config", this.state);
    } else {
      this.stage(config);
    }
    return this.state.pending?.hash === hash;
  }

  ready(facet: string): void {
    if (!this.needsSwap(facet)) return;
    this.readyRequested.add(facet);
    void this.swap();
  }

  // The configuration the next swap lands on.
  private target(): AppConfig | null {
    return this.state.pending ?? this.state.current;
  }

  private stage(config: AppConfig): void {
    if (this.state.pending?.hash !== config.hash) this.readyRequested.clear();
    this.state.pendingSince ??= Date.now();
    this.state.pending = config;
    this.ctx.storage.kv.put("app-config", this.state);
    // Replacing pending code/scope never extends an already-running deadline.
    if (this.drainTimer === undefined) {
      // Active timers prevent DO hibernation; no durable alarm is needed for live bodies.
      this.drainTimer = setTimeout(() => void this.swap(true), Number(this.env.DRAIN_DEADLINE_MS));
    }
    void this.swap();
  }

  private loaded(name: string) {
    return this.ctx.storage.sql
      .exec<{ name: string; loadedHash: string | null; loadedReadOnly: number }>(
        "SELECT name, loadedHash, loadedReadOnly FROM facets WHERE name = ?",
        name,
      )
      .toArray()[0];
  }

  private needsSwap(name: string): boolean {
    const loaded = this.loaded(name);
    const target = this.state.pending;
    return !!(
      target &&
      loaded?.loadedHash &&
      (loaded.loadedHash !== target.hash || !!loaded.loadedReadOnly !== target.readOnly)
    );
  }

  private async swap(force = false, restartCommit = false): Promise<void> {
    if (this.swapping) {
      this.forceRequested ||= force;
      return;
    }
    if (!this.state.pending) return;
    const scopeChange = this.ctx.storage.sql
      .exec<{ loadedReadOnly: number }>(
        "SELECT loadedReadOnly FROM facets WHERE loadedHash IS NOT NULL",
      )
      .toArray()
      .some((row) => !!row.loadedReadOnly !== this.state.pending!.readOnly);
    // Props changes remain an object-wide admission drain.
    if (!force && !restartCommit && scopeChange && this.active.size) return;
    this.swapping = true;
    const originalTarget = this.state.pending;
    try {
      const target = this.state.pending;
      const facets = this.ctx.storage.sql
        .exec<{ name: string }>("SELECT name FROM facets")
        .toArray()
        .filter(({ name }) => this.needsSwap(name));
      const selected = facets.filter(
        ({ name }) =>
          force ||
          restartCommit ||
          (scopeChange && !this.active.size) ||
          (this.readyRequested.has(name) && !this.runningAlarms.has(name)),
      );
      if (selected.length && (force || scopeChange || restartCommit)) {
        await Promise.all(selected.map(({ name }) => this.closeSockets(name)));
        // A newer publication or scope may arrive while the close RPC is in flight.
        if (this.state.pending !== target) return;
      }
      const swappedAt = Date.now();
      this.ctx.storage.transactionSync(() => {
        const record = (name: string | null, oldHash: string | null, abortedStreams: number) => {
          this.ctx.storage.sql.exec(
            `INSERT INTO swaps
              (facet, oldHash, newHash, kind, pendingSince, swappedAt, forced, abortedStreams, restartCommit)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            name,
            oldHash,
            target.hash,
            oldHash === target.hash ? "scope" : "code",
            this.state.pendingSince ?? swappedAt,
            swappedAt,
            Number(force),
            abortedStreams,
            Number(restartCommit),
          );
        };
        for (const { name } of selected) {
          const oldHash = this.loaded(name)!.loadedHash!;
          const controllers = [...this.active]
            .filter(([, facet]) => facet === name)
            .map(([controller]) => controller);
          record(name, oldHash, force ? controllers.filter((c) => this.streams.has(c)).length : 0);
          if (force) {
            const reason: UpdateAbort = {
              reason: "drain-deadline",
              oldVersion: oldHash,
              newVersion: target.hash,
            };
            for (const controller of controllers) {
              controller.abort(reason);
              this.active.delete(controller);
            }
          }
          // Null marks an aborted, not-yet-instantiated facet. Its next load uses the target.
          this.ctx.storage.sql.exec("UPDATE facets SET loadedHash = NULL WHERE name = ?", name);
          this.readyRequested.delete(name);
        }
        if (!this.state.current) record(null, null, 0);
        if (selected.length === facets.length) {
          this.state = { current: target, pending: null };
          clearTimeout(this.drainTimer);
          this.drainTimer = undefined;
          this.readyRequested.clear();
        }
        this.ctx.storage.kv.put("app-config", this.state);
        this.ctx.storage.sql.exec(
          "DELETE FROM swaps WHERE id NOT IN (SELECT id FROM swaps ORDER BY id DESC LIMIT 100)",
        );
      });
      for (const { name } of selected) {
        this.ctx.facets.abort(
          name,
          new Error(force ? "Drain deadline exceeded" : "Code or scope updated"),
        );
      }
    } finally {
      this.swapping = false;
      const forced = this.forceRequested;
      this.forceRequested = false;
      if (this.state.pending && (forced || this.state.pending !== originalTarget)) {
        void this.swap(force || forced);
      }
    }
  }

  private async closeSockets(name: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.facet(name).closeSockets(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
    } catch {
      // Closing is best-effort; an unresponsive facet must still be aborted.
    } finally {
      clearTimeout(timer);
    }
  }

  private facet(name: string) {
    const { hash, readOnly } = this.target()!;
    const scope = { supervisorId: this.ctx.id.toString(), readOnly };
    return this.ctx.facets.get(name, () => {
      // The callback runs only when the runtime instantiates the facet, so this records real loads.
      this.ctx.storage.sql.exec(
        `INSERT INTO facets (name, createdAt, loadedHash, loadedAt, loadedReadOnly) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET loadedHash = excluded.loadedHash, loadedAt = excluded.loadedAt, loadedReadOnly = excluded.loadedReadOnly`,
        name,
        Date.now(),
        hash,
        Date.now(),
        Number(readOnly),
      );
      return loadApp(this.env, hash, scope, name);
    });
  }

  private beginWork(facet: string) {
    const controller = new AbortController();
    this.active.set(controller, facet);
    const release = () => {
      // Old header/body completions after a forced swap cannot release new work.
      this.streams.delete(controller);
      if (this.active.delete(controller)) void this.swap();
    };
    return { controller, release };
  }

  private async serve(request: Request, facet = "app"): Promise<Response> {
    const { controller, release } = this.beginWork(facet);
    try {
      const response = await this.facet(facet).fetch(request);
      // A hibernatable socket is not an application operation or a response body.
      if (response.status === 101) {
        release();
        return response;
      }
      if (response.body && !controller.signal.aborted) this.streams.add(controller);
      return trackResponseBody(response, controller.signal, release);
    } catch (error) {
      release();
      // A deadline can also cut work still waiting for response headers.
      if (controller.signal.aborted) {
        return new Response("Update aborted request; retry", {
          status: 503,
          headers: { "Retry-After": "1", "Cache-Control": "no-store" },
        });
      }
      throw error;
    }
  }
}
