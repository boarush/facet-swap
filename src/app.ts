import { DurableObject } from "cloudflare:workers";

import type { ScopedNotes } from "./notes";
import { createRouter } from "./router";
import type { Scheduler } from "./scheduler";

declare const VERSION: string;

type AppEnv = {
  HASH: string;
  NOTES: Service<ScopedNotes>;
  SCHEDULER: Service<Scheduler>;
};

export class App extends DurableObject<AppEnv> {
  // Native event names cannot be invoked through a DurableObject RPC stub.
  dispatchAlarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.alarm(info);
  }

  async alarm(_info?: AlarmInvocationInfo): Promise<void> {
    const count = this.ctx.storage.kv.get<number>("alarms") ?? 0;
    this.ctx.storage.kv.put("alarms", count + 1);
    this.ctx.storage.kv.put("last-alarm", {
      hash: this.env.HASH,
      scheduled: await this.env.SCHEDULER.getAlarm(),
    });
  }

  private readonly router = createRouter<AppEnv>()
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
        const { time } = await request.json<{ time: number }>();
        if (!Number.isSafeInteger(time) || time <= 0) {
          return new Response("Invalid alarm time", { status: 400 });
        }
        await c.env.SCHEDULER.setAlarm(time);
      } else if (request.method === "DELETE") {
        await c.env.SCHEDULER.deleteAlarm();
      } else if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      return Response.json({
        scheduled: await c.env.SCHEDULER.getAlarm(),
        count: this.ctx.storage.kv.get<number>("alarms") ?? 0,
        last: this.ctx.storage.kv.get("last-alarm") ?? null,
      });
    })
    .all("/alarm", () => new Response("Method not allowed", { status: 405 }))
    .on(["GET", "PUT"], "/notes", async (c) => {
      // URLSearchParams preserves the original decoding behavior for capability keys.
      const key = new URL(c.req.url).searchParams.get("key") ?? "note";
      try {
        if (c.req.method === "PUT") {
          await c.env.NOTES.put(key, await c.req.raw.text());
        } else if (c.req.method !== "GET") {
          return new Response("Method not allowed", { status: 405 });
        }
        return Response.json({
          value: await c.env.NOTES.get(key),
          gateway: await c.env.NOTES.revision(),
        });
      } catch (error) {
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
    return this.router.fetch(request, this.env);
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

// Loader preflight compiles the module without constructing or invoking the durable facet.
export default { fetch: () => new Response(null, { status: 204 }) };
