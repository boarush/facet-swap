import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkerEntrypoint: class {},
  exports: {},
}));

const { default: worker } = await import("../src/worker");
const { App } = await import("../src/app");
const { createRouter } = await import("../src/router");

afterEach(() => vi.unstubAllGlobals());

function entry() {
  const forwarded = [];
  const env = {
    SUPERVISORS: {
      idFromName: (user) => user,
      get: (user) => ({
        fetch: async (request) => {
          forwarded.push({ user, request });
          return new Response("forwarded", { headers: { "x-test": "untouched" } });
        },
      }),
    },
  };
  return {
    forwarded,
    fetch: (path, init) => worker.fetch(new Request("http://local" + path, init), env),
  };
}

function facet() {
  vi.stubGlobal("VERSION", "v1");
  const data = new Map();
  const env = {
    HASH: "1234567890abcdef",
    NOTES: {
      get: vi.fn(async (key) => key),
      put: vi.fn(async () => {}),
      revision: async () => "g1",
    },
    SCHEDULER: {
      getAlarm: async () => null,
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
    },
  };
  const app = new App(
    { storage: { kv: { get: (key) => data.get(key), put: (key, value) => data.set(key, value) } } },
    env,
  );
  return { env, data, fetch: (path, init) => app.fetch(new Request("http://local" + path, init)) };
}

test("entry routes keep exact paths, methods, raw user identity and forwarded requests", async () => {
  const h = entry();
  for (const path of ["/", "/u", "/u/", "/u//version", "/health/", "/%68ealth", "/__local/code"]) {
    const response = await h.fetch(path);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), "Not found");
  }
  assert.equal(await (await h.fetch("/health", { method: "POST" })).text(), "ready");
  for (const [path, user, suffix] of [
    ["/u/alice", "alice", "/"],
    ["/u/alice/", "alice", "/"],
    ["/u/a%2Fb/notes?key=x%2By", "a%2Fb", "/notes?key=x%2By"],
    ["/u/%61lice/%76ersion", "%61lice", "/%76ersion"],
    ["/u/alice//notes", "alice", "//notes"],
  ]) {
    const response = await h.fetch(path, {
      method: "PUT",
      body: "payload",
      headers: { "x-input": "yes" },
    });
    assert.equal(response.headers.get("x-test"), "untouched");
    const forwarded = h.forwarded.at(-1);
    assert.equal(forwarded.user, user);
    assert.equal(forwarded.request.url, "http://local" + suffix);
    assert.equal(forwarded.request.method, "PUT");
    assert.equal(forwarded.request.headers.get("x-input"), "yes");
    assert.equal(await forwarded.request.text(), "payload");
  }
});

test("facet routes retain method errors, validation, query decoding and exact 404s", async () => {
  const h = facet();
  for (const path of ["/", "/version/", "/%76ersion", "/notes/"]) {
    const response = await h.fetch(path);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found");
  }
  assert.equal(
    (await (await h.fetch("/version", { method: "POST" })).json()).hash,
    "1234567890abcdef",
  );
  for (const path of ["/notes", "/alarm"]) {
    for (const method of ["POST", "PATCH", "OPTIONS", "HEAD"]) {
      const response = await h.fetch(path, { method });
      assert.equal(response.status, 405, path + " " + method);
      if (method !== "HEAD") assert.equal(await response.text(), "Method not allowed");
    }
  }
  assert.equal((await (await h.fetch("/notes?key=a+b&key=ignored")).json()).value, "a b");
  assert.equal((await (await h.fetch("/notes?key=")).json()).value, "");
  assert.equal((await (await h.fetch("/notes")).json()).value, "note");
  assert.equal((await h.fetch("/alarm", { method: "PUT", body: '{"time":0}' })).status, 400);
  assert.equal((await h.fetch("/stream?n=0")).status, 400);
  assert.equal((await h.fetch("/stream?ms=Infinity")).status, 400);
  const stream = await h.fetch("/stream?n=1&ms=0", { method: "POST" });
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.equal(stream.headers.get("cache-control"), "no-cache");
  assert.match(await stream.text(), /^id: 1\ndata: /);
});

test("routing propagates unexpected errors and cancels discarded HEAD bodies", async () => {
  const app = createRouter();
  const cancelled = vi.fn();
  app.all(
    "/stream",
    () =>
      new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  app.all("/error", () => {
    throw new Error("not swallowed");
  });
  const response = await app.request("/stream", { method: "HEAD" });
  assert.equal(response.body, null);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(cancelled.mock.calls.length, 1);
  await assert.rejects(async () => app.request("/error"), /not swallowed/);
  const h = facet();
  h.env.SCHEDULER.setAlarm.mockRejectedValueOnce(new Error("scheduler unavailable"));
  await assert.rejects(
    h.fetch("/alarm", { method: "PUT", body: '{"time":123}' }),
    /scheduler unavailable/,
  );
});
