import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, test, vi } from "vitest";

import type { Env } from "../alchemy.run";

vi.mock("cloudflare:workers", () => ({
  exports: {
    ScopedNotes: () => ({}),
    Scheduler: () => ({}),
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
    dispatchAlarm: vi.fn<(info?: AlarmInvocationInfo) => Promise<void>>(async () => {}),
    fetch: async (_request: Request): Promise<Response> => new Response(),
  };
  const ctx = {
    id: { toString: () => "user" },
    storage,
    facets: {
      get: vi.fn<() => typeof facet>(() => facet),
      abort: vi.fn<(name: string, reason: Error) => void>(),
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
  const status = async (s = supervisor) =>
    (await s.fetch(new Request("http://local/__status"))).json<{
      current: { hash: string; generation: number; readOnly: boolean } | null;
      pending: { hash: string; generation: number; readOnly: boolean } | null;
      pendingSince: number | null;
      swaps: Swap[];
      inflight: number;
      swapping: boolean;
    }>();
  const swaps = async (s = supervisor, query = "") => {
    const response = await s.fetch(new Request("http://local/__status" + query));
    assert.equal(response.status, 200);
    return (await response.json<{ swaps: Swap[] }>()).swaps;
  };
  return {
    supervisor,
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

test("failed delivery persists across Supervisor restart and is retried on latest code", async () => {
  const h = harness();
  const due = Date.now() - 1;
  await h.supervisor.setAlarm(due);
  h.facet.dispatchAlarm.mockImplementationOnce(async () => {
    assert.equal(h.supervisor.getAlarm(), null);
    assert.equal((await h.status()).inflight, 1);
    throw new Error("transient");
  });
  await assert.rejects(h.supervisor.alarm(), /transient/);
  assert.equal(h.supervisor.getAlarm(), due);
  assert.equal((await h.status()).inflight, 0);
  h.env.latest = hash(2);
  const restarted = h.create();
  assert.equal(restarted.getAlarm(), due);
  await restarted.alarm({ scheduledTime: due, retryCount: 1, isRetry: true });
  assert.equal(restarted.getAlarm(), null);
  assert.equal((await h.status(restarted)).current!.hash, hash(2));
  assert.deepEqual(h.facet.dispatchAlarm.mock.calls[1][0], {
    scheduledTime: due,
    retryCount: 1,
    isRetry: true,
  });
});

test("handler rearming for the same timestamp is not erased on completion", async () => {
  const h = harness();
  const due = Date.now() - 1;
  await h.supervisor.setAlarm(new Date(due));
  h.facet.dispatchAlarm.mockImplementationOnce(async () => {
    assert.equal(h.supervisor.getAlarm(), null);
    await h.supervisor.setAlarm(due);
    assert.equal(h.supervisor.getAlarm(), due);
  });
  await h.supervisor.alarm();
  assert.equal(h.supervisor.getAlarm(), due);
  await h.supervisor.alarm();
  assert.equal(h.supervisor.getAlarm(), null);
});

test("deletion during failed delivery cancels any later retry", async () => {
  const h = harness();
  await h.supervisor.setAlarm(Date.now() - 1);
  h.facet.dispatchAlarm.mockImplementationOnce(async () => {
    await h.supervisor.deleteAlarm();
    throw new Error("already cancelled");
  });
  await assert.rejects(h.supervisor.alarm(), /already cancelled/);
  await h.supervisor.alarm();
  assert.equal(h.supervisor.getAlarm(), null);
  assert.equal(h.native(), null);
  assert.equal(h.facet.dispatchAlarm.mock.calls.length, 1);
});

test("a stale native callback cannot deliver an alarm replaced with a future time", async () => {
  const h = harness();
  const future = Date.now() + 60000;
  await h.supervisor.setAlarm(future);
  await h.supervisor.alarm();
  assert.equal(h.facet.dispatchAlarm.mock.calls.length, 0);
  assert.equal(h.native(), future);
  assert.equal(h.supervisor.getAlarm(), future);
});

test("an executing alarm counts as inflight and a hard swap retries it on new code", async () => {
  vi.useFakeTimers();
  const h = harness();
  const due = Date.now() - 1;
  await h.supervisor.setAlarm(due);
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
  const response = await h.supervisor.fetch(new Request("http://local/version"));
  assert.equal(response.status, 503);
  assert.equal((await h.status()).pending!.hash, hash(2));
  await vi.advanceTimersByTimeAsync(3000);
  await rejected;
  assert.equal((await h.status()).current!.hash, hash(2));
  assert.equal((await h.status()).inflight, 0);
  assert.equal((await h.swaps())[0].abortedStreams, 0);
  assert.equal((await h.swaps())[0].forced, true);
  assert.equal(h.supervisor.getAlarm(), due);
  await h.supervisor.alarm();
  assert.equal(h.supervisor.getAlarm(), null);
});

test("pending swap and due alarm both survive reconstruction without a fresh drain window", async () => {
  const h = harness();
  const due = Date.now() - 1;
  await h.supervisor.setAlarm(due);
  h.data.set("app-config", {
    current: { hash: hash(1), generation: 1, readOnly: false },
    pending: { hash: hash(2), generation: 2, readOnly: false },
    pendingSince: due - 100,
  });
  h.env.latest = hash(2);
  const restarted = h.create();
  assert.equal((await h.status(restarted)).current!.hash, hash(2));
  assert.equal((await h.status(restarted)).pending, null);
  assert.equal(restarted.getAlarm(), due);
  assert.deepEqual((await h.swaps(restarted))[0], {
    id: 1,
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
  assert.equal(restarted.getAlarm(), null);
});

test("Hono control routes retain update-check ordering and do not reach the facet", async () => {
  const h = harness();
  h.env.latest = hash(2);
  assert.equal((await h.status()).current!.hash, hash(1));
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  const methodError = await h.supervisor.fetch(new Request("http://local/__scope"));
  assert.equal(methodError.status, 405);
  assert.equal(await methodError.text(), "Method not allowed");
  assert.equal((await h.status()).current!.hash, hash(2));
  const invalid = await h.supervisor.fetch(
    new Request("http://local/__scope", { method: "PUT", body: '{"readOnly":"yes"}' }),
  );
  assert.equal(invalid.status, 400);
  await assert.rejects(
    h.supervisor.fetch(
      new Request("http://local/__scope", { method: "PUT", body: "invalid json" }),
    ),
    SyntaxError,
  );
  assert.equal(h.ctx.facets.get.mock.calls.length, 0);
});

test("unchanged scope is a no-op instead of a drain", async () => {
  const h = harness();
  const { readOnly } = (await h.status()).current!;
  const response = await h.supervisor.fetch(
    new Request("http://local/__scope", { method: "PUT", body: JSON.stringify({ readOnly }) }),
  );
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
  const response = await h.supervisor.fetch(new Request("http://local/stream", { method: "HEAD" }));
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.equal(cancelled.mock.calls.length, 1);
  assert.equal((await h.status()).inflight, 0);
});

test("normal body drain logs one unforced swap with its original pending time", async () => {
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
  const response = await h.supervisor.fetch(new Request("http://local/stream"));
  const done = response.text();
  const pendingSince = Date.now();
  h.env.latest = hash(2);
  assert.equal((await h.supervisor.fetch(new Request("http://local/version"))).status, 503);
  assert.deepEqual(await h.swaps(), []);
  const draining = await h.status();
  assert.equal(draining.pendingSince, pendingSince);
  assert.equal(draining.inflight, 1);
  assert.equal(draining.swapping, false);
  await vi.advanceTimersByTimeAsync(100);
  h.env.latest = hash(3);
  assert.equal((await h.supervisor.fetch(new Request("http://local/version"))).status, 503);
  await vi.advanceTimersByTimeAsync(100);
  source.close();
  await done;
  assert.deepEqual(await h.swaps(), [
    {
      id: 1,
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
  const first = await h.supervisor.fetch(new Request("http://local/stream"));
  const second = await h.supervisor.fetch(new Request("http://local/stream"));
  const firstDone = first.text();
  const secondDone = second.text();
  const pendingSince = Date.now();
  h.env.latest = hash(2);
  await h.supervisor.fetch(new Request("http://local/version"));
  await vi.advanceTimersByTimeAsync(3000);
  assert.match(await firstDone, /update-abort/);
  assert.match(await secondDone, /update-abort/);
  assert.deepEqual(await h.swaps(), [
    {
      id: 1,
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
  const scoped = await h.supervisor.fetch(new Request("http://local/stream"));
  const scopedDone = scoped.text();
  await h.supervisor.fetch(
    new Request("http://local/__scope", {
      method: "PUT",
      body: '{"readOnly":true}',
    }),
  );
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
    h.env.latest = hash(i);
    await h.supervisor.fetch(new Request("http://local/version"));
  }
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
    const response = await h.supervisor.fetch(new Request("http://local/__status?swaps=" + limit));
    assert.equal(response.status, 400);
  }
  const head = await h.supervisor.fetch(new Request("http://local/__status", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await h.supervisor.fetch(new Request("http://local/__status", { method }));
    assert.equal(response.status, 405, method);
    assert.equal(await response.text(), "Method not allowed");
  }
  const status = await h.status();
  assert.deepEqual(Object.keys(status).sort(), [
    "current",
    "inflight",
    "pending",
    "pendingSince",
    "swapping",
    "swaps",
  ]);
  assert.equal(status.current!.hash, hash(106));
  assert.equal(status.pendingSince, null);
  assert.equal(h.env.VERSIONS.get.mock.calls.length, 0);
  assert.equal(h.ctx.facets.get.mock.calls.length, 105);
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

test("non-increasing publications cannot replace a newer pending or committed generation", async () => {
  const h = harness();
  h.facet.fetch = async () => new Response(new ReadableStream());
  const response = await h.supervisor.fetch(new Request("http://local/stream"));
  h.env.latest = hash(3);
  assert.equal((await h.supervisor.fetch(new Request("http://local/version"))).status, 503);
  assert.equal((await h.status()).pending!.generation, 3);
  for (const generation of [2, 3]) {
    h.env.latest = hash(2);
    h.env.generation = generation;
    await h.supervisor.fetch(new Request("http://local/version"));
    assert.equal((await h.status()).pending!.hash, hash(3));
  }
  await response.body!.cancel();
  assert.equal((await h.status()).current!.generation, 3);
  const restarted = h.create();
  await restarted.fetch(new Request("http://local/version", { method: "HEAD" }));
  assert.equal((await h.status(restarted)).current!.hash, hash(3));
  assert.equal(h.env.CODE.get.mock.calls.length, 1);
  const scoped = await restarted.fetch(
    new Request("http://local/__scope", {
      method: "PUT",
      body: '{"readOnly":true}',
    }),
  );
  assert.equal(scoped.status, 200);
  assert.equal((await h.status(restarted)).current!.generation, 3);
});

test("KV failure serves current requests and alarms, then retries at the next interval", async () => {
  vi.useFakeTimers();
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = harness();
  h.env.CHECK_INTERVAL_MS = "100";
  h.env.VERSIONS.get.mockRejectedValueOnce(new Error("KV unavailable"));
  assert.equal((await h.supervisor.fetch(new Request("http://local/version"))).status, 200);
  await h.supervisor.setAlarm(Date.now() - 1);
  await h.supervisor.alarm();
  assert.equal(h.facet.dispatchAlarm.mock.calls.length, 1);
  assert.equal(h.env.VERSIONS.get.mock.calls.length, 1);
  h.env.latest = hash(2);
  await vi.advanceTimersByTimeAsync(100);
  h.env.VERSIONS.get.mockRejectedValueOnce(new Error("KV unavailable on alarm"));
  await h.supervisor.setAlarm(Date.now() - 1);
  await h.supervisor.alarm();
  assert.equal(h.facet.dispatchAlarm.mock.calls.length, 2);
  assert.equal((await h.status()).current!.hash, hash(1));
  await vi.advanceTimersByTimeAsync(100);
  const response = await h.supervisor.fetch(new Request("http://local/version"));
  await response.body?.cancel();
  assert.equal((await h.status()).current!.hash, hash(2));
  assert.equal(diagnostic.mock.calls.length, 2);
});

test("malformed publications and missing code never stage; repaired code retries successfully", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = harness();
  h.env.generation = 2;
  for (const invalid of ["../escape", "a".repeat(63), "A".repeat(64)]) {
    h.env.latest = invalid;
    const response = await h.supervisor.fetch(new Request("http://local/version"));
    await response.body?.cancel();
    assert.equal((await h.status()).current!.hash, hash(1));
    assert.equal((await h.status()).pending, null);
  }
  assert.equal(h.env.CODE.get.mock.calls.length, 0);
  h.env.latest = hash(2);
  h.env.CODE.get.mockResolvedValueOnce(null);
  const response = await h.supervisor.fetch(new Request("http://local/version"));
  await response.body?.cancel();
  assert.equal((await h.status()).current!.generation, 1);
  assert.equal((await h.status()).pending, null);
  assert.deepEqual(await h.swaps(), []);
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  assert.equal(diagnostic.mock.calls.length, 4);
  const repaired = await h.supervisor.fetch(new Request("http://local/version"));
  await repaired.body?.cancel();
  assert.equal((await h.status()).current!.hash, hash(2));
  assert.equal((await h.status()).current!.generation, 2);
  assert.equal(h.env.CODE.get.mock.calls.length, 2);
});

test("republishing identical code advances generation without aborting inflight work", async () => {
  const h = harness();
  h.facet.fetch = async () => new Response(new ReadableStream());
  const response = await h.supervisor.fetch(new Request("http://local/stream"));
  h.env.generation = 2;
  const repeated = await h.supervisor.fetch(
    new Request("http://local/version", { method: "HEAD" }),
  );
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
  let response = await h.supervisor.fetch(new Request("http://local/version"));
  await response.body?.cancel();
  h.env.latest = hash(1);
  h.env.generation = 3;
  response = await h.supervisor.fetch(new Request("http://local/version"));
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
    const response = await h.supervisor.fetch(new Request("http://local/version"));
    await response.body?.cancel();
    assert.equal((await h.status()).pending, null);
    assert.equal((await h.status()).current!.hash, hash(1));
  }
  assert.equal(h.env.CODE.get.mock.calls.length, 0);
  h.env.generation = 2;
  h.env.CODE.get.mockRejectedValueOnce(new Error("code read failed"));
  const response = await h.supervisor.fetch(new Request("http://local/version"));
  await response.body?.cancel();
  assert.equal((await h.status()).pending, null);
  assert.equal((await h.status()).current!.hash, hash(1));
  assert.equal(diagnostic.mock.calls.length, 6);
});
