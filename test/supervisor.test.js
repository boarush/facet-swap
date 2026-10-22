import assert from "node:assert/strict";

import { afterEach, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("../src/version-source", () => ({
  VersionSource: class {
    constructor(env) {
      this.env = env;
    }
    async check(onLatest) {
      onLatest(this.env.latest);
    }
  },
  loadApp: async (_env, hash) => ({ class: hash }),
}));
const { Supervisor } = await import("../src/supervisor");

afterEach(() => vi.useRealTimers());

function harness() {
  const data = new Map([
    ["app-config", { current: { hash: "v1", readOnly: false }, pending: null }],
  ]);
  let native = null;
  const kv = {
    get: (key) => structuredClone(data.get(key)),
    put: (key, value) => data.set(key, structuredClone(value)),
    delete: (key) => data.delete(key),
  };
  const storage = {
    kv,
    get: async (key) => kv.get(key),
    put: async (key, value) => {
      kv.put(key, value);
    },
    delete: async (key) => kv.delete(key),
    setAlarm: async (time) => {
      native = Number(time);
    },
    deleteAlarm: async () => {
      native = null;
    },
    transaction: async (fn) => fn(storage),
  };
  const facet = { dispatchAlarm: vi.fn(async () => {}) };
  const ctx = {
    id: { toString: () => "user" },
    storage,
    facets: { get: vi.fn(() => facet), abort: vi.fn() },
  };
  const env = { latest: "v1", DRAIN_DEADLINE_MS: "3000" };
  const create = () => new Supervisor(ctx, env);
  const supervisor = create();
  const status = async (s = supervisor) =>
    (await s.fetch(new Request("http://local/__status"))).json();
  return { supervisor, create, storage, data, facet, ctx, env, status, native: () => native };
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
  assert.equal((await h.status(restarted)).current.hash, "v2");
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
  let interrupt;
  h.facet.dispatchAlarm.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
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
  assert.equal((await h.status()).pending.hash, "v2");
  await vi.advanceTimersByTimeAsync(3000);
  await rejected;
  assert.equal((await h.status()).current.hash, "v2");
  assert.equal((await h.status()).inflight, 0);
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
  });
  h.env.latest = "v2";
  const restarted = h.create();
  assert.equal((await h.status(restarted)).current.hash, "v2");
  assert.equal((await h.status(restarted)).pending, null);
  assert.equal(restarted.getAlarm(), due);
  await restarted.alarm();
  assert.equal(restarted.getAlarm(), null);
});

test("Hono control routes retain update-check ordering and do not reach the facet", async () => {
  const h = harness();
  h.env.latest = "v2";
  assert.equal((await h.status()).current.hash, "v1");
  assert.equal(h.ctx.facets.abort.mock.calls.length, 0);
  const methodError = await h.supervisor.fetch(new Request("http://local/__scope"));
  assert.equal(methodError.status, 405);
  assert.equal(await methodError.text(), "Method not allowed");
  assert.equal((await h.status()).current.hash, "v2");
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
  const cancelled = vi.fn();
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
