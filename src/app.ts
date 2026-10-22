import { DurableObject } from "cloudflare:workers";

import type { ScopedNotes } from "./notes";
import type { Scheduler } from "./scheduler";

declare const VERSION: string;

export class App extends DurableObject<{
  HASH: string;
  NOTES: Service<ScopedNotes>;
  SCHEDULER: Service<Scheduler>;
}> {
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Facet state lives only in its SQLite-backed storage, which survives abort.
    const served = this.ctx.storage.kv.get<number>("served") ?? 0;

    if (url.pathname === "/version") {
      return Response.json({
        v: this.env.HASH.slice(0, 12),
        label: VERSION || undefined,
        hash: this.env.HASH,
        served,
      });
    }
    if (url.pathname === "/alarm") {
      if (request.method === "PUT") {
        const { time } = await request.json<{ time: number }>();
        if (!Number.isSafeInteger(time) || time <= 0) {
          return new Response("Invalid alarm time", { status: 400 });
        }
        await this.env.SCHEDULER.setAlarm(time);
      } else if (request.method === "DELETE") {
        await this.env.SCHEDULER.deleteAlarm();
      } else if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      return Response.json({
        scheduled: await this.env.SCHEDULER.getAlarm(),
        count: this.ctx.storage.kv.get<number>("alarms") ?? 0,
        last: this.ctx.storage.kv.get("last-alarm") ?? null,
      });
    }
    if (url.pathname === "/notes") {
      const key = url.searchParams.get("key") ?? "note";
      try {
        if (request.method === "PUT") {
          await this.env.NOTES.put(key, await request.text());
        } else if (request.method !== "GET") {
          return new Response("Method not allowed", { status: 405 });
        }
        return Response.json({
          value: await this.env.NOTES.get(key),
          gateway: await this.env.NOTES.revision(),
        });
      } catch (error) {
        return new Response(String(error), { status: 403 });
      }
    }
    if (url.pathname !== "/stream") return new Response("Not found", { status: 404 });

    const count = Number(url.searchParams.get("n") ?? 10);
    const intervalMs = Number(url.searchParams.get("ms") ?? 500);
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

    this.ctx.storage.kv.put("served", served + 1);
    return this.stream(count, intervalMs, served + 1);
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
