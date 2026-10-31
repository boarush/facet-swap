import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, test, vi } from "vitest";

import type { Env } from "../alchemy.run";

vi.mock("cloudflare:workers", () => ({
  exports: {
    ScopedNotes: () => ({}),
    Scheduler: () => ({}),
    Versions: () => ({}),
    Swap: () => ({}),
  },
  DurableObject: class {
    ctx: DurableObjectState;
    env: unknown;
    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const { Supervisor } = await import("../src/supervisor");

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

type Swap = {
  id: number;
  facet: string | null;
  oldHash: string | null;
  newHash: string;
  kind: "code" | "scope";
  pendingSince: number;
  swappedAt: number;
  forced: boolean;
  abortedStreams: number;
  restartCommit: boolean;
};

const hash = (n: number) => n.toString(16).padStart(64, "0");

function harness() {
  const data = new Map<string, unknown>([
    ["app-config", { current: { hash: hash(1), generation: 1, readOnly: false }, pending: null }],
  ]);
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  let native: number | null = null;
  const kv = {
    get: (key: string) => structuredClone(data.get(key)),
    put: (key: string, value: unknown) => data.set(key, structuredClone(value)),
    delete: (key: string) => data.delete(key),
  };
  type Storage = {
    kv: typeof kv;
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(time: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  const storage = {
    kv,
    sql: {
      exec: (query: string, ...bindings: SQLInputValue[]) => {
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
    transactionSync: <T>(fn: () => T): T => {
      const snapshot = structuredClone(data);
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        data.clear();
        for (const [key, value] of snapshot) data.set(key, value);
        throw error;
      }
    },
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: unknown) => {
      kv.put(key, value);
    },
    delete: async (key: string) => kv.delete(key),
    setAlarm: async (time: number | Date) => {
      native = Number(time);
    },
    deleteAlarm: async () => {
      native = null;
    },
    transaction: async <T>(fn: (transaction: Storage) => Promise<T>): Promise<T> => fn(storage),
  };
  const facet = {
    closeSockets: vi.fn<() => Promise<void>>(async () => {}),
    dispatchAlarm: vi.fn<(info?: AlarmInvocationInfo) => Promise<void>>(async () => {}),
    fetch: async (_request: Request): Promise<Response> => new Response(),
  };
  const loaded = new Set(["app"]);
  const ctx = {
    id: { toString: () => "user" },
    storage,
    facets: {
      get: vi.fn<(name: string, factory: () => unknown) => typeof facet>((name, factory) => {
        if (!loaded.has(name)) {
          factory();
          loaded.add(name);
        }
        return facet;
      }),
      abort: vi.fn<(name: string, reason: Error) => void>((name) => {
        loaded.delete(name);
      }),
    },
  };
  const env = {
    latest: hash(1),
    generation: undefined as number | undefined,
    DRAIN_DEADLINE_MS: "3000",
    CHECK_INTERVAL_MS: "0",
    VERSIONS: {
      get: vi.fn<() => Promise<{ hash: string; generation: number }>>(
        async (): Promise<{ hash: string; generation: number }> => ({
          hash: env.latest,
          generation: env.generation ?? parseInt(env.latest.slice(-8), 16),
        }),
      ),
    },
    CODE: {
      get: vi.fn<(_key: string) => Promise<{ text: () => Promise<string> } | null>>(async () => ({
        text: async () => "module",
      })),
    },
    LOADER: {
      get: (_key: string, getCode: () => Promise<unknown>) => ({
        getEntrypoint: () => ({
          fetch: async () => {
            await getCode();
            return new Response(null, { status: 204 });
          },
        }),
        getDurableObjectClass: () => ({}),
      }),
    },
  };
  // These partial fakes deliberately model only the Supervisor's exercised dependencies.
  const create = () => new Supervisor(ctx as unknown as DurableObjectState, env as unknown as Env);
  const supervisor = create();
  // The stub bypasses the runtime's loader callback; model its registered app facet.
  storage.sql.exec(
    "INSERT INTO facets (name, createdAt, loadedHash, loadedAt) VALUES ('app', ?, ?, ?)",
    Date.now(),
    hash(1),
    Date.now(),
  );
  const fetch = (path: string, init?: RequestInit, s = supervisor) =>
    s.fetch(new Request("http://local" + path, init));
  const status = async (s = supervisor) =>
    (await fetch("/__status", undefined, s)).json<{
      current: { hash: string; generation: number; readOnly: boolean } | null;
      pending: { hash: string; generation: number; readOnly: boolean } | null;
      pendingSince: number | null;
      swaps: Swap[];
      inflight: number;
      swapping: boolean;
    }>();
  const swaps = async (s = supervisor, query = "") => {
    const response = await fetch("/__status" + query, undefined, s);
    assert.equal(response.status, 200);
    return (await response.json<{ swaps: Swap[] }>()).swaps;
  };
  return {
    supervisor,
    fetch,
    create,
    storage,
    data,
    facet,
    ctx,
    env,
    status,
    swaps,
    native: () => native,
  };
}

test("handler rearming for the same timestamp is not erased on completion", async () => {
  const h = harness();
  const due = Date.now() - 1;
  await h.supervisor.setAlarm("app", new Date(due));
  h.facet.dispatchAlarm.mockImplementationOnce(async () => {
    assert.equal(h.supervisor.getAlarm("app"), null);
    await h.supervisor.setAlarm("app", due);
    assert.equal(h.supervisor.getAlarm("app"), due);
  });
  await h.supervisor.alarm();
  assert.equal(h.supervisor.getAlarm("app"), due);
  await h.supervisor.alarm();
  assert.equal(h.supervisor.getAlarm("app"), null);
});

test("deletion during failed delivery cancels any later retry", async () => {
  const h = harness();
  await h.supervisor.setAlarm("app", Date.now() - 1);
  h.facet.dispatchAlarm.mockImplementationOnce(async () => {
    await h.supervisor.deleteAlarm("app");
    throw new Error("already cancelled");
  });
  await assert.rejects(h.supervisor.alarm(), /already cancelled/);
  await h.supervisor.alarm();
  assert.equal(h.supervisor.getAlarm("app"), null);
  assert.equal(h.native(), null);
  assert.equal(h.facet.dispatchAlarm.mock.calls.length, 1);
});

test("a stale native callback cannot deliver an alarm replaced with a future time", async () => {
  const h = harness();
  const future = Date.now() + 60000;
  await h.supervisor.setAlarm("app", future);
  await h.supervisor.alarm();
  assert.equal(h.facet.dispatchAlarm.mock.calls.length, 0);
  assert.equal(h.native(), future);
  assert.equal(h.supervisor.getAlarm("app"), future);
});

test("pending swap and due alarm both survive reconstruction without a fresh drain window", async () => {
  const h = harness();
  const due = Date.now() - 1;
  await h.supervisor.setAlarm("app", due);
  h.data.set("app-config", {
    current: { hash: hash(1), generation: 1, readOnly: false },
    pending: { hash: hash(2), generation: 2, readOnly: false },
    pendingSince: due - 100,
  });
  h.env.latest = hash(2);
  const restarted = h.create();
  assert.equal((await h.status(restarted)).current!.hash, hash(2));
  assert.equal((await h.status(restarted)).pending, null);
  assert.equal(restarted.getAlarm("app"), due);
  assert.deepEqual((await h.swaps(restarted))[0], {
    id: 1,
    facet: "app",
    oldHash: hash(1),
    newHash: hash(2),
    kind: "code",
    pendingSince: due - 100,
    swappedAt: (await h.swaps(restarted))[0].swappedAt,
    forced: false,
    abortedStreams: 0,
    restartCommit: true,
  });
  assert.equal((await h.swaps(h.create())).length, 1);
  await restarted.alarm();
  assert.equal(restarted.getAlarm("app"), null);
});

test("unchanged scope is a no-op instead of a drain", async () => {
  const h = harness();
  const { readOnly } = (await h.status()).current!;
  const response = await h.fetch("/__scope", { method: "PUT", body: JSON.stringify({ readOnly }) });
  assert.deepEqual(await response.json(), { accepted: true, changed: false });
  assert.equal((await h.status()).pending, null);
  assert.equal((await h.swaps()).length, 0);
});

test("HEAD cancels the Supervisor response wrapper instead of leaking inflight", async () => {
  const h = harness();
  const cancelled = vi.fn<(reason?: unknown) => void>();
  h.facet.fetch = async () =>
    new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  const response = await h.fetch("/stream", { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.equal(cancelled.mock.calls.length, 1);
  assert.equal((await h.status()).inflight, 0);
});

test("initial activation and legacy pending state are logged without invented drain time", async () => {
  const h = harness();
  h.data.set("app-config", {
    current: null,
    pending: { hash: hash(1), generation: 1, readOnly: false },
  });
  const restarted = h.create();
  const [row] = await h.swaps(restarted);
  assert.equal(row.oldHash, null);
  assert.equal(row.kind, "code");
  assert.equal(row.pendingSince, row.swappedAt);
  assert.equal(row.restartCommit, true);
});

test("facets arm the minimum wake-up and deliver only their own due alarm", async () => {
  const h = harness();
  h.storage.sql.exec(
    "INSERT INTO facets (name, createdAt, loadedHash, loadedAt) VALUES ('other', ?, ?, ?)",
    Date.now(),
    hash(1),
    Date.now(),
  );
  const other = {
    ...h.facet,
    dispatchAlarm: vi.fn<() => Promise<void>>(async () => {}),
    fetch: h.facet.fetch,
  };
  h.ctx.facets.get.mockImplementation((name: string) => (name === "other" ? other : h.facet));
  const due = Date.now() - 1;
  const future = Date.now() + 60000;
  await h.supervisor.setAlarm("other", future);
  await h.supervisor.setAlarm("app", due);
  assert.equal(h.native(), due);
  assert.equal(h.supervisor.getAlarm("other"), future);
  await h.supervisor.alarm();
  assert.equal(h.facet.dispatchAlarm.mock.calls.length, 1);
  assert.equal(other.dispatchAlarm.mock.calls.length, 0);
  assert.equal(h.supervisor.getAlarm("app"), null);
  assert.equal(h.native(), future);
  await h.supervisor.setAlarm("other", due);
  await h.supervisor.alarm();
  assert.equal(other.dispatchAlarm.mock.calls.length, 1);
  assert.equal(h.facet.dispatchAlarm.mock.calls.length, 1);
  assert.equal(h.native(), null);
});

test("a failed facet does not block another due facet and retains only its own retry", async () => {
  const h = harness();
  h.storage.sql.exec(
    "INSERT INTO facets (name, createdAt, loadedHash, loadedAt) VALUES ('other', ?, ?, ?)",
    Date.now(),
    hash(1),
    Date.now(),
  );
  const other = {
    ...h.facet,
    dispatchAlarm: vi.fn<() => Promise<void>>(async () => {
      assert.equal(h.supervisor.getAlarm("other"), null);
      assert.equal(h.supervisor.getAlarm("app"), due);
      await h.supervisor.deleteAlarm("other");
    }),
    fetch: h.facet.fetch,
  };
  h.ctx.facets.get.mockImplementation((name: string) => (name === "other" ? other : h.facet));
  const due = Date.now() - 1;
  await h.supervisor.setAlarm("app", due);
  await h.supervisor.setAlarm("other", due);
  h.facet.dispatchAlarm.mockRejectedValueOnce(new Error("app failed"));
  const arm = vi.spyOn(h.storage, "setAlarm");
  await assert.rejects(h.supervisor.alarm(), /app failed/);
  assert.equal(arm.mock.calls.length, 0);
  assert.equal(other.dispatchAlarm.mock.calls.length, 1);
  assert.equal(h.supervisor.getAlarm("other"), null);
  assert.equal(h.supervisor.getAlarm("app"), due);
  assert.equal(h.native(), due);
  await h.supervisor.alarm();
  assert.equal(h.native(), null);
  assert.equal(other.dispatchAlarm.mock.calls.length, 1);
});

test("fetch, controls and alarm delivery never read KV on their own", async () => {
  const h = harness();
  h.env.latest = hash(2);
  const response = await h.fetch("/version");
  await response.body?.cancel();
  await h.fetch("/__scope");
  await h.supervisor.setAlarm("app", Date.now() - 1);
  await h.supervisor.alarm();
  assert.equal(h.env.VERSIONS.get.mock.calls.length, 0);
  assert.equal((await h.status()).current!.hash, hash(1));
});

test("pending validates publication and ready swaps without response-lifetime gating", async () => {
  const h = harness();
  h.env.latest = hash(2);
  assert.equal(await h.supervisor.pending(hash(3)), false);
  assert.equal((await h.status()).pending, null);
  assert.equal(await h.supervisor.pending("../escape"), false);
  assert.equal(await h.supervisor.pending(hash(2)), true);
  assert.equal((await h.fetch("/version")).status, 503);
  h.supervisor.ready("app");
  assert.equal((await h.status()).current!.hash, hash(2));
  assert.equal((await h.swaps())[0].forced, false);
  assert.deepEqual(
    h.ctx.facets.abort.mock.calls.map(([name]) => name),
    ["app"],
  );
});

test("a pending target keeps the original deadline and forced SSE suffix", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.facet.fetch = async () =>
    new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
  const response = await h.fetch("/stream");
  const done = response.text();
  h.env.latest = hash(2);
  await h.supervisor.pending(hash(2));
  const pendingSince = (await h.status()).pendingSince;
  await vi.advanceTimersByTimeAsync(1000);
  h.env.latest = hash(3);
  await h.supervisor.pending(hash(3));
  assert.equal((await h.status()).pendingSince, pendingSince);
  await vi.advanceTimersByTimeAsync(2000);
  assert.match(await done, /update-abort/);
  assert.equal((await h.status()).current!.hash, hash(3));
  const [row] = await h.swaps();
  assert.equal(row.forced, true);
  assert.equal(row.abortedStreams, 1);
});

test("preflight errors and stale generations preserve current code", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = harness();
  h.env.latest = hash(2);
  h.env.CODE.get.mockResolvedValueOnce(null);
  assert.equal(await h.supervisor.pending(hash(2)), false);
  assert.equal(await h.supervisor.pending(hash(2)), true);
  h.supervisor.ready("app");
  h.env.latest = hash(1);
  h.env.generation = 1;
  assert.equal(await h.supervisor.pending(hash(1)), false);
  assert.equal((await h.status()).current!.hash, hash(2));
  await (await h.fetch("/version")).body?.cancel();
  h.env.generation = 3;
  assert.equal(await h.supervisor.pending(hash(1)), true);
  h.supervisor.ready("app");
  assert.equal((await h.status()).current!.generation, 3);
});

test("scope changes during preflight remain on the pending target", async () => {
  const h = harness();
  h.env.latest = hash(2);
  let finish!: () => void;
  h.env.CODE.get.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { text: async () => "module" };
  });
  const pending = h.supervisor.pending(hash(2));
  await vi.waitFor(() => assert(finish));
  await h.fetch("/__scope", { method: "PUT", body: '{"readOnly":true}' });
  finish();
  await pending;
  h.supervisor.ready("app");
  assert.equal((await h.status()).current!.readOnly, true);
});

test("swaps preserve independent alarms and abort every registered facet", async () => {
  const h = harness();
  h.storage.sql.exec(
    "INSERT INTO facets (name,createdAt,loadedHash,loadedAt) VALUES ('other',1,?,1)",
    hash(1),
  );
  const time = Date.now() + 60000;
  await h.supervisor.setAlarm("other", time);
  h.env.latest = hash(2);
  await h.supervisor.pending(hash(2));
  h.supervisor.ready("app");
  h.supervisor.ready("other");
  assert.deepEqual(h.ctx.facets.abort.mock.calls.map(([name]) => name).sort(), ["app", "other"]);
  assert.equal(h.supervisor.getAlarm("other"), time);
});

test("101 responses pass through unchanged and do not count as work", async () => {
  const h = harness();
  const response = new Response();
  Object.defineProperty(response, "status", { value: 101 });
  h.facet.fetch = async () => response;
  assert.equal(await h.fetch("/ws", { headers: { Upgrade: "websocket" } }), response);
  assert.equal((await h.status()).inflight, 0);
});

test("a slow old preflight cannot supersede a newer facet's target", async () => {
  const h = harness();
  h.env.latest = hash(2);
  let finish!: () => void;
  h.env.CODE.get.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { text: async () => "module" };
  });
  const older = h.supervisor.pending(hash(2));
  await vi.waitFor(() => assert(finish));
  h.env.latest = hash(3);
  assert.equal(await h.supervisor.pending(hash(3)), true);
  finish();
  assert.equal(await older, false);
  assert.equal((await h.status()).pending!.hash, hash(3));
  h.supervisor.ready("app");
});

test("failed delivery persists across Supervisor restart and is retried on latest code", async () => {
  const h = harness();
  const due = Date.now() - 1;
  await h.supervisor.setAlarm("app", due);
  h.facet.dispatchAlarm.mockImplementationOnce(async () => {
    assert.equal(h.supervisor.getAlarm("app"), null);
    assert.equal((await h.status()).inflight, 1);
    throw new Error("transient");
  });
  await assert.rejects(h.supervisor.alarm(), /transient/);
  assert.equal(h.supervisor.getAlarm("app"), due);
  assert.equal((await h.status()).inflight, 0);
  h.env.latest = hash(2);
  const restarted = h.create();
  assert.equal(restarted.getAlarm("app"), due);
  await restarted.pending(hash(2));
  restarted.ready("app");
  await restarted.alarm({ scheduledTime: due, retryCount: 1, isRetry: true });
  assert.equal(restarted.getAlarm("app"), null);
  assert.equal((await h.status(restarted)).current!.hash, hash(2));
  assert.deepEqual(h.facet.dispatchAlarm.mock.calls[1][0], {
    scheduledTime: due,
    retryCount: 1,
    isRetry: true,
  });
});

test("an executing alarm counts as inflight and a hard swap retries it on new code", async () => {
  vi.useFakeTimers();
  const h = harness();
  const due = Date.now() - 1;
  await h.supervisor.setAlarm("app", due);
  let interrupt: ((reason: Error) => void) | undefined;
  h.facet.dispatchAlarm.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        interrupt = reject;
      }),
  );
  h.ctx.facets.abort.mockImplementation(() => interrupt?.(new Error("facet aborted")));
  const delivery = h.supervisor.alarm();
  const rejected = assert.rejects(delivery, /facet aborted/);
  await vi.waitFor(async () => assert.equal((await h.status()).inflight, 1));
  h.env.latest = hash(2);
  await h.supervisor.pending(h.env.latest);
  const response = await h.fetch("/version");
  assert.equal(response.status, 503);
  assert.equal((await h.status()).pending!.hash, hash(2));
  h.supervisor.ready("app");
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(3000);
  await rejected;
  assert.equal((await h.status()).current!.hash, hash(2));
  assert.equal((await h.status()).inflight, 0);
  assert.equal((await h.swaps())[0].abortedStreams, 0);
  assert.equal((await h.swaps())[0].forced, true);
  assert.equal(h.supervisor.getAlarm("app"), due);
  await h.supervisor.alarm();
  assert.equal(h.supervisor.getAlarm("app"), null);
});

test("application readiness after body drain logs one unforced swap with its original pending time", async () => {
  vi.useFakeTimers();
  const h = harness();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  h.facet.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      }),
    );
  const response = await h.fetch("/stream");
  const done = response.text();
  const pendingSince = Date.now();
  h.env.latest = hash(2);
  await h.supervisor.pending(h.env.latest);
  assert.equal((await h.fetch("/version")).status, 503);
  assert.deepEqual(await h.swaps(), []);
  const draining = await h.status();
  assert.equal(draining.pendingSince, pendingSince);
  assert.equal(draining.inflight, 1);
  assert.equal(draining.swapping, false);
  await vi.advanceTimersByTimeAsync(100);
  h.env.latest = hash(3);
  await h.supervisor.pending(h.env.latest);
  assert.equal((await h.fetch("/version")).status, 503);
  await vi.advanceTimersByTimeAsync(100);
  source.close();
  await done;
  h.supervisor.ready("app");
  assert.deepEqual(await h.swaps(), [
    {
      id: 1,
      facet: "app",
      oldHash: hash(1),
      newHash: hash(3),
      kind: "code",
      pendingSince,
      swappedAt: pendingSince + 200,
      forced: false,
      abortedStreams: 0,
      restartCommit: false,
    },
  ]);
  await vi.advanceTimersByTimeAsync(3000);
  assert.equal((await h.swaps()).length, 1);
});

test("deadline logs forced code and scope swaps with the aborted body count", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.facet.fetch = async () =>
    new Response(new ReadableStream(), {
      headers: { "content-type": "text/event-stream" },
    });
  const first = await h.fetch("/stream");
  const second = await h.fetch("/stream");
  const firstDone = first.text();
  const secondDone = second.text();
  const pendingSince = Date.now();
  h.env.latest = hash(2);
  await h.supervisor.pending(h.env.latest);
  await vi.advanceTimersByTimeAsync(3000);
  assert.match(await firstDone, /update-abort/);
  assert.match(await secondDone, /update-abort/);
  assert.deepEqual(await h.swaps(), [
    {
      id: 1,
      facet: "app",
      oldHash: hash(1),
      newHash: hash(2),
      kind: "code",
      pendingSince,
      swappedAt: pendingSince + 3000,
      forced: true,
      abortedStreams: 2,
      restartCommit: false,
    },
  ]);
  const scoped = await h.fetch("/stream");
  const scopedDone = scoped.text();
  await h.fetch("/__scope", {
    method: "PUT",
    body: '{"readOnly":true}',
  });
  await vi.advanceTimersByTimeAsync(3000);
  await scopedDone;
  const [scope] = await h.swaps();
  assert.equal(scope.kind, "scope");
  assert.equal(scope.oldHash, scope.newHash);
  assert.equal(scope.forced, true);
  assert.equal(scope.abortedStreams, 1);
});

test("swap diagnostics are read-only, bypass checks, and retain only the newest 100 rows", async () => {
  const h = harness();
  for (let i = 2; i <= 106; i++) {
    await (await h.fetch("/version")).body?.cancel();
    h.env.latest = hash(i);
    await h.supervisor.pending(h.env.latest);
    h.supervisor.ready("app");
  }
  h.ctx.facets.get.mockClear();
  h.env.latest = "not-observed";
  h.env.VERSIONS.get.mockClear();
  const rows = await h.swaps(h.supervisor, "?swaps=200");
  assert.equal(rows.length, 100);
  assert.equal(rows[0].newHash, hash(106));
  assert.equal(rows[99].newHash, hash(7));
  assert.equal((await h.swaps()).length, 20);
  assert.equal((await h.swaps(h.supervisor, "?swaps=1")).length, 1);
  assert.equal((await h.status()).current!.hash, hash(106));
  assert.equal(h.storage.sql.exec("SELECT COUNT(*) AS count FROM swaps").toArray()[0].count, 100);
  assert.deepEqual(await h.swaps(h.supervisor, "?swaps=0"), []);
  for (const limit of ["-1", "1.5", "abc", "", "9007199254740992", "1%20OR%201"]) {
    const response = await h.fetch("/__status?swaps=" + limit);
    assert.equal(response.status, 400);
  }
  const head = await h.fetch("/__status", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await h.fetch("/__status", { method });
    assert.equal(response.status, 405, method);
    assert.equal(await response.text(), "Method not allowed");
  }
  const status = await h.status();
  assert.deepEqual(Object.keys(status).sort(), [
    "current",
    "facets",
    "inflight",
    "pending",
    "pendingSince",
    "swapping",
    "swaps",
  ]);
  assert.equal(status.current!.hash, hash(106));
  assert.equal(status.pendingSince, null);
  assert.equal(h.env.VERSIONS.get.mock.calls.length, 0);
  assert.equal(h.ctx.facets.get.mock.calls.length, 0);
});

test("malformed publications and missing code never stage; repaired code retries successfully", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = harness();
  h.env.generation = 2;
  for (const invalid of ["../escape", "a".repeat(63), "A".repeat(64)]) {
    h.env.latest = invalid;
    await h.supervisor.pending(hash(2));
    const response = await h.fetch("/version");
    await response.body?.cancel();
    assert.equal((await h.status()).current!.hash, hash(1));
    assert.equal((await h.status()).pending, null);
  }
  assert.equal(h.env.CODE.get.mock.calls.length, 0);
  h.env.latest = hash(2);
  h.env.CODE.get.mockResolvedValueOnce(null);
  await h.supervisor.pending(hash(2));
  const response = await h.fetch("/version");
  await response.body?.cancel();
  assert.equal((await h.status()).current!.generation, 1);
  assert.equal((await h.status()).pending, null);
  assert.deepEqual(await h.swaps(), []);
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  assert.equal(diagnostic.mock.calls.length, 4);
  await h.supervisor.pending(h.env.latest);
  h.supervisor.ready("app");
  assert.equal((await h.status()).current!.hash, hash(2));
  assert.equal((await h.status()).current!.generation, 2);
  assert.equal(h.env.CODE.get.mock.calls.length, 2);
});

test("republishing identical code advances generation without aborting inflight work", async () => {
  const h = harness();
  h.facet.fetch = async () => new Response(new ReadableStream());
  const response = await h.fetch("/stream");
  h.env.generation = 2;
  await h.supervisor.pending(h.env.latest);
  const repeated = await h.fetch("/version", { method: "HEAD" });
  assert.equal(repeated.status, 200);
  assert.equal((await h.status()).pending, null);
  assert.equal((await h.status()).current!.generation, 2);
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  assert.deepEqual(await h.swaps(), []);
  await response.body!.cancel();
});

test("a greater generation can deliberately republish an older content hash", async () => {
  const h = harness();
  h.env.latest = hash(2);
  await h.supervisor.pending(h.env.latest);
  h.supervisor.ready("app");
  let response = await h.fetch("/version");
  await response.body?.cancel();
  h.env.latest = hash(1);
  h.env.generation = 3;
  await h.supervisor.pending(h.env.latest);
  h.supervisor.ready("app");
  response = await h.fetch("/version");
  await response.body?.cancel();
  assert.equal((await h.status()).current!.hash, hash(1));
  assert.equal((await h.status()).current!.generation, 3);
});

test("invalid generation and code read failure never close admission", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = harness();
  h.env.latest = hash(2);
  for (const generation of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    h.env.generation = generation;
    await h.supervisor.pending(h.env.latest);
    const response = await h.fetch("/version");
    await response.body?.cancel();
    assert.equal((await h.status()).pending, null);
    assert.equal((await h.status()).current!.hash, hash(1));
  }
  assert.equal(h.env.CODE.get.mock.calls.length, 0);
  h.env.generation = 2;
  h.env.CODE.get.mockRejectedValueOnce(new Error("code read failed"));
  await h.supervisor.pending(h.env.latest);
  const response = await h.fetch("/version");
  await response.body?.cancel();
  assert.equal((await h.status()).pending, null);
  assert.equal((await h.status()).current!.hash, hash(1));
  assert.equal(diagnostic.mock.calls.length, 6);
});

test("deleting one facet alarm keeps the other armed and swaps abort every registered facet", async () => {
  const h = harness();
  h.storage.sql.exec(
    "INSERT INTO facets (name, createdAt, loadedHash, loadedAt) VALUES ('other', ?, ?, ?)",
    Date.now(),
    hash(1),
    Date.now(),
  );
  const time = Date.now() + 60000;
  await h.supervisor.setAlarm("app", time);
  await h.supervisor.setAlarm("other", time + 1000);
  await h.supervisor.deleteAlarm("app");
  assert.equal(h.supervisor.getAlarm("app"), null);
  assert.equal(h.native(), time + 1000);
  h.env.latest = hash(2);
  await h.supervisor.pending(h.env.latest);
  h.supervisor.ready("app");
  h.supervisor.ready("other");
  assert.deepEqual(h.ctx.facets.abort.mock.calls.map(([name]) => name).sort(), ["app", "other"]);
  assert.equal(h.supervisor.getAlarm("other"), time + 1000);
});

test("concurrent initial requests share one publication read and preflight", async () => {
  const h = harness();
  h.data.delete("app-config");
  const fresh = h.create();
  let finish!: () => void;
  h.env.VERSIONS.get.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { hash: hash(1), generation: 1 };
  });
  const first = h.fetch("/version", undefined, fresh);
  const second = h.fetch("/version", undefined, fresh);
  await vi.waitFor(() => assert(finish));
  assert.equal(h.env.VERSIONS.get.mock.calls.length, 1);
  finish();
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.status, 200);
    await response.body?.cancel();
  }
  assert.equal(h.env.VERSIONS.get.mock.calls.length, 1);
  assert.equal(h.env.CODE.get.mock.calls.length, 1);
  assert.equal((await h.status(fresh)).current!.hash, hash(1));
  await h.fetch("/version", { method: "HEAD" }, fresh);
  await fresh.alarm();
  assert.equal(h.env.VERSIONS.get.mock.calls.length, 1);
});

test("initial alarm wake bootstraps without a second publication read", async () => {
  const h = harness();
  const due = Date.now() - 1;
  await h.supervisor.setAlarm("app", due);
  h.data.delete("app-config");
  const fresh = h.create();
  await fresh.alarm();
  assert.equal(h.env.VERSIONS.get.mock.calls.length, 1);
  assert.equal(h.facet.dispatchAlarm.mock.calls.length, 1);
  assert.equal(fresh.getAlarm("app"), null);
});

test("failed initial preflight leaves admission closed and a later request retries", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = harness();
  h.data.delete("app-config");
  const fresh = h.create();
  h.env.CODE.get.mockResolvedValueOnce(null);
  assert.equal((await h.fetch("/version", undefined, fresh)).status, 503);
  assert.equal((await h.status(fresh)).current, null);
  assert.equal(h.env.VERSIONS.get.mock.calls.length, 1);
  assert.equal((await h.fetch("/version", { method: "HEAD" }, fresh)).status, 200);
  assert.equal(h.env.VERSIONS.get.mock.calls.length, 2);
});

test("ready waits for an executing alarm then swaps without waiting for HTTP bodies", async () => {
  const h = harness();
  h.facet.fetch = async () => new Response(new ReadableStream());
  const response = await h.fetch("/stream");
  let finish!: () => void;
  h.facet.dispatchAlarm.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await h.supervisor.setAlarm("app", Date.now() - 1);
  const delivery = h.supervisor.alarm();
  await vi.waitFor(() => assert(finish));
  h.env.latest = hash(2);
  await h.supervisor.pending(hash(2));
  h.supervisor.ready("app");
  assert.equal((await h.status()).current!.hash, hash(1));
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  finish();
  await delivery;
  assert.equal((await h.status()).current!.hash, hash(2));
  assert.equal((await h.swaps())[0].forced, false);
  assert.equal((await h.swaps())[0].abortedStreams, 0);
  await response.body!.cancel();
});

test("scope drains wait for alarm delivery even after explicit readiness", async () => {
  const h = harness();
  let finish!: () => void;
  h.facet.dispatchAlarm.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await h.supervisor.setAlarm("app", Date.now() - 1);
  const delivery = h.supervisor.alarm();
  await vi.waitFor(() => assert(finish));
  await h.fetch("/__scope", { method: "PUT", body: '{"readOnly":true}' });
  h.supervisor.ready("app");
  assert.equal((await h.status()).current!.readOnly, false);
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  finish();
  await delivery;
  await vi.waitFor(async () => assert.equal((await h.status()).current!.readOnly, true));
});

test("non-increasing publications cannot replace a newer pending or committed generation", async () => {
  const h = harness();
  h.facet.fetch = async () => new Response(new ReadableStream());
  const response = await h.fetch("/stream");
  h.env.latest = hash(3);
  await h.supervisor.pending(h.env.latest);
  assert.equal((await h.fetch("/version")).status, 503);
  assert.equal((await h.status()).pending!.generation, 3);
  for (const generation of [2, 3]) {
    h.env.latest = hash(2);
    h.env.generation = generation;
    await h.supervisor.pending(h.env.latest);
    assert.equal((await h.status()).pending!.hash, hash(3));
  }
  await response.body!.cancel();
  h.supervisor.ready("app");
  assert.equal((await h.status()).current!.generation, 3);
  const restarted = h.create();
  await h.fetch("/version", { method: "HEAD" }, restarted);
  assert.equal((await h.status(restarted)).current!.hash, hash(3));
  assert.equal(h.env.CODE.get.mock.calls.length, 1);
  const scoped = await h.fetch(
    "/__scope",
    {
      method: "PUT",
      body: '{"readOnly":true}',
    },
    restarted,
  );
  assert.equal(scoped.status, 200);
  assert.equal((await h.status(restarted)).current!.generation, 3);
});

function register(
  h: ReturnType<typeof harness>,
  name: string,
  loadedHash: string | null = hash(1),
) {
  h.storage.sql.exec(
    "INSERT INTO facets (name, createdAt, loadedHash, loadedAt) VALUES (?, 1, ?, 1)",
    name,
    loadedHash,
  );
}

test("ready swaps only its facet; admission reopens there while the deadline forces the other", async () => {
  vi.useFakeTimers();
  const h = harness();
  register(h, "other");
  register(h, "unloaded", null);
  h.env.latest = hash(2);
  await h.supervisor.pending(hash(2));
  h.supervisor.ready("unloaded");
  h.supervisor.ready("app");
  assert.deepEqual(
    h.ctx.facets.abort.mock.calls.map(([name]) => name),
    ["app"],
  );
  assert.equal((await h.status()).pending!.hash, hash(2));
  assert.equal(h.supervisor["needsSwap"]("other"), true);
  const response = await h.fetch("/version");
  assert.equal(response.status, 200);
  await response.body?.cancel();
  assert.equal(h.supervisor["loaded"]("app")!.loadedHash, hash(2));
  await vi.advanceTimersByTimeAsync(3000);
  assert.deepEqual(
    h.ctx.facets.abort.mock.calls.map(([name]) => name),
    ["app", "other"],
  );
  assert.equal((await h.status()).pending, null);
  assert.deepEqual(
    (await h.swaps()).map(({ facet, forced }) => ({ facet, forced })),
    [
      { facet: "other", forced: true },
      { facet: "app", forced: false },
    ],
  );
});

test("new facets load the pending target and are not aborted at the shared deadline", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.env.latest = hash(2);
  await h.supervisor.pending(hash(2));
  h.supervisor["facet"]("new");
  assert.equal(h.supervisor["loaded"]("new")!.loadedHash, hash(2));
  assert.equal(h.supervisor["needsSwap"]("new"), false);
  await vi.advanceTimersByTimeAsync(3000);
  assert.deepEqual(
    h.ctx.facets.abort.mock.calls.map(([name]) => name),
    ["app"],
  );
});

test("an alarm gates only its own facet's readiness", async () => {
  const h = harness();
  register(h, "other");
  let finish!: () => void;
  h.facet.dispatchAlarm.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await h.supervisor.setAlarm("app", Date.now() - 1);
  const delivery = h.supervisor.alarm();
  await vi.waitFor(() => assert(finish));
  h.env.latest = hash(2);
  await h.supervisor.pending(hash(2));
  h.supervisor.ready("app");
  h.supervisor.ready("other");
  assert.deepEqual(
    h.ctx.facets.abort.mock.calls.map(([name]) => name),
    ["other"],
  );
  finish();
  await delivery;
  assert.deepEqual(
    h.ctx.facets.abort.mock.calls.map(([name]) => name),
    ["other", "app"],
  );
  assert.equal((await h.status()).pending, null);
});

test("forced cuts end only streams belonging to old facets", async () => {
  vi.useFakeTimers();
  const h = harness();
  register(h, "other");
  h.facet.fetch = async () =>
    new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
  const old = await h.supervisor["serve"](new Request("http://local/stream"), "other");
  const oldDone = old.text();
  h.env.latest = hash(2);
  await h.supervisor.pending(hash(2));
  h.supervisor.ready("app");
  const fresh = await h.fetch("/stream");
  const reader = fresh.body!.getReader();
  await vi.advanceTimersByTimeAsync(3000);
  assert.match(await oldDone, /update-abort/);
  assert.equal((await h.status()).inflight, 1);
  assert.equal((await h.swaps())[0].abortedStreams, 1);
  await reader.cancel();
  assert.equal((await h.status()).inflight, 0);
});

test("scope updates drain all facets' admitted work before changing props", async () => {
  const h = harness();
  register(h, "other");
  const { release } = h.supervisor["beginWork"]("other");
  await h.fetch("/__scope", { method: "PUT", body: '{"readOnly":true}' });
  h.supervisor.ready("app");
  h.supervisor.ready("other");
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  assert.equal((await h.fetch("/version")).status, 503);
  release();
  await vi.waitFor(() =>
    assert.deepEqual(h.ctx.facets.abort.mock.calls.map(([name]) => name).sort(), ["app", "other"]),
  );
  assert.equal((await h.status()).current!.readOnly, true);
});

test("pending old facets do not block alarm deliveries to updated facets", async () => {
  const h = harness();
  register(h, "other");
  h.env.latest = hash(2);
  await h.supervisor.pending(hash(2));
  h.supervisor.ready("app");
  await h.supervisor.setAlarm("app", Date.now() - 1);
  await h.supervisor.setAlarm("other", Date.now() - 1);
  await h.supervisor.alarm();
  assert.equal(h.facet.dispatchAlarm.mock.calls.length, 1);
  assert.equal(h.supervisor.getAlarm("app"), null);
  assert.notEqual(h.supervisor.getAlarm("other"), null);
  assert(h.native()! > Date.now());
  h.supervisor.ready("other");
});

test("forced swaps bound socket cleanup and abort even when its RPC hangs or fails", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.facet.closeSockets.mockImplementationOnce(() => new Promise(() => {}));
  h.env.latest = hash(2);
  await h.supervisor.pending(hash(2));
  await vi.advanceTimersByTimeAsync(3000);
  assert.equal(h.facet.closeSockets.mock.calls.length, 1);
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(999);
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(h.ctx.facets.abort.mock.calls.length, 1);
  assert.equal((await h.status()).current!.hash, hash(2));

  await h.fetch("/version");
  h.facet.closeSockets.mockRejectedValueOnce(new Error("facet unavailable"));
  h.env.latest = hash(3);
  await h.supervisor.pending(hash(3));
  await vi.advanceTimersByTimeAsync(3000);
  assert.equal(h.ctx.facets.abort.mock.calls.length, 2);
  assert.equal((await h.status()).current!.hash, hash(3));
});

test("a target replaced during forced socket cleanup still swaps at the deadline", async () => {
  vi.useFakeTimers();
  const h = harness();
  let finish!: () => void;
  h.facet.closeSockets.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.env.latest = hash(2);
  await h.supervisor.pending(hash(2));
  await vi.advanceTimersByTimeAsync(3000);
  h.env.latest = hash(3);
  await h.supervisor.pending(hash(3));
  finish();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal((await h.status()).current!.hash, hash(3));
  assert.equal(h.ctx.facets.abort.mock.calls.length, 1);
  assert.equal((await h.swaps())[0].forced, true);
});
