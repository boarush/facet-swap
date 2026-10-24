import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, test, vi } from "vitest";

import type { Env } from "../alchemy.run";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: unknown;
    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("../src/version-source", () => ({
  VersionSource: class {
    env: { latest: string };
    constructor(env: { latest: string }) {
      this.env = env;
    }
    async check(onLatest: (hash: string) => void) {
      onLatest(this.env.latest);
    }
  },
  loadApp: async (_env: Env, hash: string) => ({ class: hash }),
}));
const { Supervisor } = await import("../src/supervisor");

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.useRealTimers();
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

function harness() {
  const data = new Map<string, unknown>([
    ["app-config", { current: { hash: "v1", readOnly: false }, pending: null }],
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
  const env = { latest: "v1", DRAIN_DEADLINE_MS: "3000" };
  // These partial fakes deliberately model only the Supervisor's exercised dependencies.
  const create = () => new Supervisor(ctx as unknown as DurableObjectState, env as unknown as Env);
  const supervisor = create();
  const status = async (s = supervisor) =>
    (await s.fetch(new Request("http://local/__status"))).json<{
      current: { hash: string; readOnly: boolean } | null;
      pending: { hash: string; readOnly: boolean } | null;
      inflight: number;
      swapping: boolean;
    }>();
  const swaps = async (s = supervisor, query = "") => {
    const response = await s.fetch(new Request("http://local/swaps" + query));
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
  h.env.latest = "v2";
  const restarted = h.create();
  assert.equal(restarted.getAlarm(), due);
  await restarted.alarm({ scheduledTime: due, retryCount: 1, isRetry: true });
  assert.equal(restarted.getAlarm(), null);
  assert.equal((await h.status(restarted)).current!.hash, "v2");
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
  h.env.latest = "v2";
  const response = await h.supervisor.fetch(new Request("http://local/version"));
  assert.equal(response.status, 503);
  assert.equal((await h.status()).pending!.hash, "v2");
  await vi.advanceTimersByTimeAsync(3000);
  await rejected;
  assert.equal((await h.status()).current!.hash, "v2");
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
    current: { hash: "v1", readOnly: false },
    pending: { hash: "v2", readOnly: false },
    pendingSince: due - 100,
  });
  h.env.latest = "v2";
  const restarted = h.create();
  assert.equal((await h.status(restarted)).current!.hash, "v2");
  assert.equal((await h.status(restarted)).pending, null);
  assert.equal(restarted.getAlarm(), due);
  assert.deepEqual((await h.swaps(restarted))[0], {
    id: 1,
    oldHash: "v1",
    newHash: "v2",
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
  h.env.latest = "v2";
  assert.equal((await h.status()).current!.hash, "v1");
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  const methodError = await h.supervisor.fetch(new Request("http://local/__scope"));
  assert.equal(methodError.status, 405);
  assert.equal(await methodError.text(), "Method not allowed");
  assert.equal((await h.status()).current!.hash, "v2");
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
  h.env.latest = "v2";
  assert.equal((await h.supervisor.fetch(new Request("http://local/version"))).status, 503);
  assert.deepEqual(await h.swaps(), []);
  await vi.advanceTimersByTimeAsync(100);
  h.env.latest = "v3";
  assert.equal((await h.supervisor.fetch(new Request("http://local/version"))).status, 503);
  await vi.advanceTimersByTimeAsync(100);
  source.close();
  await done;
  assert.deepEqual(await h.swaps(), [
    {
      id: 1,
      oldHash: "v1",
      newHash: "v3",
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
  h.env.latest = "v2";
  await h.supervisor.fetch(new Request("http://local/version"));
  await vi.advanceTimersByTimeAsync(3000);
  assert.match(await firstDone, /update-abort/);
  assert.match(await secondDone, /update-abort/);
  assert.deepEqual(await h.swaps(), [
    {
      id: 1,
      oldHash: "v1",
      newHash: "v2",
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
    h.env.latest = "v" + i;
    await h.supervisor.fetch(new Request("http://local/version"));
  }
  h.env.latest = "not-observed";
  const rows = await h.swaps(h.supervisor, "?limit=200");
  assert.equal(rows.length, 100);
  assert.equal(rows[0].newHash, "v106");
  assert.equal(rows[99].newHash, "v7");
  assert.equal((await h.swaps()).length, 20);
  assert.equal((await h.swaps(h.supervisor, "?limit=1")).length, 1);
  assert.equal((await h.status()).current!.hash, "v106");
  assert.equal(h.storage.sql.exec("SELECT COUNT(*) AS count FROM swaps").toArray()[0].count, 100);
  for (const limit of ["0", "-1", "1.5", "abc", "", "9007199254740992", "1%20OR%201"]) {
    const response = await h.supervisor.fetch(new Request("http://local/swaps?limit=" + limit));
    assert.equal(response.status, 400);
  }
  const head = await h.supervisor.fetch(new Request("http://local/swaps", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  const response = await h.supervisor.fetch(new Request("http://local/swaps", { method: "POST" }));
  assert.equal(response.status, 405);
  assert.equal((await h.status()).current!.hash, "v106");
});

test("initial activation and legacy pending state are logged without invented drain time", async () => {
  const h = harness();
  h.data.set("app-config", { current: null, pending: { hash: "v1", readOnly: false } });
  const restarted = h.create();
  const [row] = await h.swaps(restarted);
  assert.equal(row.oldHash, null);
  assert.equal(row.kind, "code");
  assert.equal(row.pendingSince, row.swappedAt);
  assert.equal(row.restartCommit, true);
});
