import { DurableObject } from "cloudflare:workers";

import { Alarms } from "./alarms";
import { isDenied, type NotesScope, type ScopedNotes } from "./notes";
import { createRouter } from "./router";
import type { Scheduler } from "./scheduler";
import { trackResponseBody } from "./stream-lifetime";
import { FacetUpdates, type UpdateEnv } from "./updates";

declare const VERSION: string;

type AppEnv = UpdateEnv & {
  HASH: string;
  CHECK_INTERVAL_MS: string;
  NOTES: Service<ScopedNotes>;
  SCHEDULER: Service<Scheduler>;
};

type AppProps = NotesScope & { facet: string };

export class App extends DurableObject<AppEnv, AppProps> {
  private work = 0;
  private updating?: string;
  private readonly updates = new FacetUpdates(
    this.env,
    this.ctx.props,
    this.env.HASH,
    Number(this.env.CHECK_INTERVAL_MS),
    (hash) => this.onUpdate(hash),
    this.ctx,
  );

  closeSockets(): void {
    this.updates.closeSockets();
  }

  private onUpdate(hash: string): void {
    this.updating = hash;
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(JSON.stringify({ type: "swap-pending", hash }));
    }
    this.readyWhenIdle();
  }

  private readyWhenIdle(): void {
    if (this.updating && this.work === 0) this.ctx.waitUntil(this.updates.ready());
  }

  private beginWork(): () => void {
    this.work++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.work--;
      this.readyWhenIdle();
    };
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const release = this.beginWork();
    try {
      await this.updates.check();
      socket.send(
        JSON.stringify({
          hash: this.env.HASH,
          message: typeof message === "string" ? message : Array.from(new Uint8Array(message)),
        }),
      );
    } finally {
      release();
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  // Native event names cannot be invoked through a DurableObject RPC stub.
  dispatchAlarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.alarm(info);
  }

  private readonly alarms = new Alarms(this.ctx, this.env.SCHEDULER, {
    reminder: async (payload: { text: string }) => {
      this.delivered("reminder", payload);
    },
    cleanup: async (payload: { key: string }) => {
      this.delivered("cleanup", payload);
    },
  });

  private delivered(type: string, payload: unknown): void {
    this.ctx.storage.transactionSync(() => {
      const count = this.ctx.storage.kv.get<number>("alarms") ?? 0;
      this.ctx.storage.kv.put("alarms", count + 1);
      this.ctx.storage.kv.put("last-alarm", { hash: this.env.HASH, type, payload });
    });
  }

  async alarm(_info?: AlarmInvocationInfo): Promise<void> {
    const release = this.beginWork();
    try {
      await this.alarms.run();
    } finally {
      release();
    }
  }

  private readonly router = createRouter<AppEnv>()
    .get("/ws", (c) => {
      if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("Expected WebSocket", { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: "swap-resumed", hash: this.env.HASH }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    })
    .all("/ws", () => new Response("Method not allowed", { status: 405 }))
    .get("/version", (c) =>
      Response.json({
        v: c.env.HASH.slice(0, 12),
        label: VERSION || undefined,
        hash: c.env.HASH,
        served: this.ctx.storage.kv.get<number>("served") ?? 0,
      }),
    )
    .all("/version", () => new Response("Method not allowed", { status: 405 }))
    .on(["GET", "PUT", "DELETE"], "/alarm", async (c) => {
      const request = c.req.raw;
      if (request.method === "PUT") {
        const { type, time, payload } = await request.json<{
          type: string;
          time: number;
          payload: unknown;
        }>();
        if (!Number.isSafeInteger(time) || time <= 0) {
          return new Response("Invalid alarm time", { status: 400 });
        }
        const id =
          type === "reminder" && hasString(payload, "text")
            ? await this.alarms.schedule(type, time, { text: payload.text })
            : type === "cleanup" && hasString(payload, "key")
              ? await this.alarms.schedule(type, time, { key: payload.key })
              : null;
        if (id === null) return new Response("Invalid alarm type or payload", { status: 400 });
        return Response.json({ id });
      } else if (request.method === "DELETE") {
        const raw = c.req.query("id");
        const id = Number(raw);
        if (!raw || !Number.isSafeInteger(id) || id <= 0)
          return new Response("Invalid alarm id", { status: 400 });
        await this.alarms.cancel(id);
      } else if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      return Response.json({
        alarms: this.alarms.list(),
        count: this.ctx.storage.kv.get<number>("alarms") ?? 0,
        last: this.ctx.storage.kv.get("last-alarm") ?? null,
      });
    })
    .all("/alarm", () => new Response("Method not allowed", { status: 405 }))
    .on(["GET", "PUT"], "/notes", async (c) => {
      // Decode capability keys with URLSearchParams.
      const key = new URL(c.req.url).searchParams.get("key") ?? "note";
      try {
        if (c.req.method === "PUT") {
          await this.env.NOTES.put(this.ctx.props, key, await c.req.raw.text());
        } else if (c.req.method !== "GET") {
          return new Response("Method not allowed", { status: 405 });
        }
        return Response.json({
          value: await this.env.NOTES.get(this.ctx.props, key),
          gateway: await this.env.NOTES.revision(),
        });
      } catch (error) {
        // Only scope denials are 403; gateway or storage failures propagate as errors.
        if (!isDenied(error)) throw error;
        return new Response(String(error), { status: 403 });
      }
    })
    .all("/notes", () => new Response("Method not allowed", { status: 405 }))
    .get("/stream", (c) => {
      const query = new URL(c.req.url).searchParams;
      const count = Number(query.get("n") ?? 10);
      const intervalMs = Number(query.get("ms") ?? 500);
      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 10000 ||
        !Number.isFinite(intervalMs) ||
        intervalMs < 0 ||
        intervalMs > 10000
      ) {
        return new Response("Invalid n/ms", { status: 400 });
      }

      // Facet state lives only in its SQLite-backed storage, which survives abort.
      const served = this.ctx.storage.kv.get<number>("served") ?? 0;
      this.ctx.storage.kv.put("served", served + 1);
      // Return the raw body so cancellation and Supervisor deadline tracking stay intact.
      return this.stream(count, intervalMs, served + 1);
    })
    .all("/stream", () => new Response("Method not allowed", { status: 405 }));

  async fetch(request: Request): Promise<Response> {
    const release = this.beginWork();
    try {
      await this.updates.check();
      if (this.updating) {
        release();
        return new Response("Update pending; retry later", {
          status: 503,
          headers: {
            "Retry-After": "1",
            "X-Current-Version": this.env.HASH,
            "X-Pending-Version": this.updating,
            "Cache-Control": "no-store",
          },
        });
      }
      const response = await this.router.fetch(request, this.env);
      if (response.status === 101) {
        release();
        return response;
      }
      // Demo work includes stream lifetime, not idle sockets.
      return trackResponseBody(response, new AbortController().signal, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  private stream(count: number, intervalMs: number, served: number): Response {
    let seq = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (seq > 0 && intervalMs > 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, intervalMs);
          });
        }
        if (cancelled) return;

        seq++;
        const event = {
          v: this.env.HASH.slice(0, 12),
          label: VERSION || undefined,
          hash: this.env.HASH,
          seq,
          msg: "hello from " + this.env.HASH.slice(0, 12),
          served,
        };
        controller.enqueue(
          encoder.encode("id: " + seq + "\ndata: " + JSON.stringify(event) + "\n\n"),
        );
        if (seq === count) controller.close();
      },
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
        wake?.();
      },
    });

    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }
}

const hasString = <K extends string>(value: unknown, key: K): value is Record<K, string> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<K, unknown>)[key] === "string";

// Loader preflight compiles the module without constructing or invoking the durable facet.
export default { fetch: () => new Response(null, { status: 204 }) };
