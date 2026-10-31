import { DurableObject } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

import { createRouter } from "./router";
import { trackResponseBody, type UpdateAbort } from "./stream-lifetime";
import { loadApp, VersionSource } from "./version-source";

type ScheduledAlarm = { name: string; time: number; token: string };

type AppConfig = { hash: string; generation: number; readOnly: boolean };
type VersionState = {
  current: AppConfig | null;
  pending: AppConfig | null;
  pendingSince?: number;
};
type SwapRow = {
  id: number;
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
  private readonly runningAlarms = new Map<string, string>();
  private readonly active = new Set<AbortController>();
  private readonly streams = new Set<AbortController>();
  private drainTimer?: ReturnType<typeof setTimeout>;
  private readonly versions: VersionSource;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.versions = new VersionSource(env);
    this.state = ctx.storage.kv.get<VersionState>("app-config") ?? { current: null, pending: null };
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS swaps (
        id INTEGER PRIMARY KEY,
        oldHash TEXT, newHash TEXT NOT NULL, kind TEXT NOT NULL,
        pendingSince INTEGER NOT NULL, swappedAt INTEGER NOT NULL,
        forced INTEGER NOT NULL, abortedStreams INTEGER NOT NULL, restartCommit INTEGER NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS facets (
        name TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, loadedHash TEXT NOT NULL, loadedAt INTEGER NOT NULL,
        alarmTime INTEGER, alarmToken TEXT
      )
    `);
    // Inflight tracking cannot survive restart; finish any persisted pending swap on wake.
    this.swap(false, true);
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
    .use(async (_c, next) => {
      await this.checkForUpdate();
      await next();
    })
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
      if (this.state.pending) {
        return new Response("Update pending; retry later", {
          status: 503,
          headers: {
            "Retry-After": "1",
            "X-Current-Version": this.state.current?.hash ?? "",
            "X-Pending-Version": this.state.pending.hash,
            "Cache-Control": "no-store",
          },
        });
      }
      if (!this.state.current) return new Response("Publish a version first", { status: 503 });
      return this.serve(c.req.raw);
    });

  async fetch(request: Request): Promise<Response> {
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
    const [{ time }] = this.ctx.storage.sql
      .exec<{ time: number | null }>("SELECT MIN(alarmTime) AS time FROM facets")
      .toArray();
    // Replacing an overdue native alarm resets its retry metadata. Let the throw retry it.
    if (retrying && time !== null && time <= Date.now() && !this.state.pending) return;
    if (time === null) await this.ctx.storage.deleteAlarm();
    else
      await this.ctx.storage.setAlarm(
        this.state.pending ? Math.max(time, Date.now() + 2000) : time,
      );
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    await this.checkForUpdate();
    const due = this.ctx.storage.sql
      .exec<ScheduledAlarm>(
        "SELECT name, alarmTime AS time, alarmToken AS token FROM facets WHERE alarmTime <= ? ORDER BY alarmTime, name",
        Date.now(),
      )
      .toArray();
    const failures: unknown[] = [];
    for (const scheduled of due) {
      if (this.state.pending) break;
      // A preceding handler may cancel or replace another facet's wake-up.
      const [current] = this.ctx.storage.sql
        .exec<{ token: string | null }>(
          "SELECT alarmToken AS token FROM facets WHERE name = ?",
          scheduled.name,
        )
        .toArray();
      if (current?.token !== scheduled.token) continue;
      if (!this.state.current) throw new Error("Publish a version first");
      const { release } = this.beginWork();
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

  private checkForUpdate(): Promise<void> {
    return this.versions.check(async (latest) => {
      if (latest === null || latest === undefined) return;
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
        const highest = Math.max(
          this.state.current?.generation ?? 0,
          this.state.pending?.generation ?? 0,
        );
        if (latest.generation <= highest) return;
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
        return;
      }
      const target = this.target();
      if (target?.hash === config.hash) {
        // A forced republication of identical code advances ordering, not the drain.
        target.generation = config.generation;
        this.ctx.storage.kv.put("app-config", this.state);
      } else {
        this.stage(config);
      }
    });
  }

  // The configuration the next swap lands on.
  private target(): AppConfig | null {
    return this.state.pending ?? this.state.current;
  }

  private stage(config: AppConfig): void {
    this.state.pendingSince ??= Date.now();
    this.state.pending = config;
    this.ctx.storage.kv.put("app-config", this.state);
    // Replacing pending code/scope never extends an already-running deadline.
    if (this.drainTimer === undefined) {
      // Active timers prevent DO hibernation; no durable alarm is needed for live bodies.
      this.drainTimer = setTimeout(() => this.swap(true), Number(this.env.DRAIN_DEADLINE_MS));
    }
    this.swapWhenIdle();
  }

  private swapWhenIdle(): void {
    if (this.active.size === 0) this.swap();
  }

  private swap(force = false, restartCommit = false): void {
    if (this.swapping || !this.state.pending || (!force && this.active.size !== 0)) return;
    this.swapping = true;
    try {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
      const reason: UpdateAbort = {
        reason: "drain-deadline",
        oldVersion: this.state.current?.hash ?? "",
        newVersion: this.state.pending.hash,
      };
      const swappedAt = Date.now();
      const next = { current: this.state.pending, pending: null };
      // Commit history with current atomically; restart must not lose or duplicate a row.
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.kv.put("app-config", next);
        this.ctx.storage.sql.exec(
          `INSERT INTO swaps
            (oldHash, newHash, kind, pendingSince, swappedAt, forced, abortedStreams, restartCommit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          this.state.current?.hash ?? null,
          next.current.hash,
          this.state.current?.hash === next.current.hash ? "scope" : "code",
          this.state.pendingSince ?? swappedAt,
          swappedAt,
          Number(force),
          force ? this.streams.size : 0,
          Number(restartCommit),
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM swaps WHERE id NOT IN (SELECT id FROM swaps ORDER BY id DESC LIMIT 100)",
        );
      });
      this.state = next;
      // Finish Supervisor-owned SSE bodies before aborting their facet source.
      if (force) {
        for (const controller of this.active) controller.abort(reason);
        this.active.clear();
      }
      // Abort restarts facet code but preserves its SQLite storage.
      for (const { name } of this.ctx.storage.sql
        .exec<{ name: string }>("SELECT name FROM facets")
        .toArray()) {
        this.ctx.facets.abort(
          name,
          new Error(force ? "Drain deadline exceeded" : "Code or scope updated"),
        );
      }
    } finally {
      this.swapping = false;
    }
  }

  private facet(name: string) {
    const { hash, readOnly } = this.state.current!;
    const scope = { supervisorId: this.ctx.id.toString(), readOnly };
    return this.ctx.facets.get(name, () => {
      // The callback runs only when the runtime instantiates the facet, so this records real loads.
      this.ctx.storage.sql.exec(
        `INSERT INTO facets (name, createdAt, loadedHash, loadedAt) VALUES (?, ?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET loadedHash = excluded.loadedHash, loadedAt = excluded.loadedAt`,
        name,
        Date.now(),
        hash,
        Date.now(),
      );
      return loadApp(this.env, hash, scope, name);
    });
  }

  private beginWork() {
    const controller = new AbortController();
    this.active.add(controller);
    const release = () => {
      // Old header/body completions after a forced swap cannot release new work.
      this.streams.delete(controller);
      if (this.active.delete(controller)) this.swapWhenIdle();
    };
    return { controller, release };
  }

  private async serve(request: Request): Promise<Response> {
    const { controller, release } = this.beginWork();
    try {
      const response = await this.facet("app").fetch(request);
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
