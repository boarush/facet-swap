import assert from "node:assert/strict";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import * as Test from "alchemy/Test/Vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { resources } from "../alchemy.run.ts";

const port = await new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const base = "http://127.0.0.1:" + port;
process.env.PORT = String(port);
process.env.CHECK_INTERVAL_MS = "0";
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  stage: "test_" + process.pid,
});
async function get(path) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function until(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(20);
  }
  throw new Error("Condition timed out");
}
function stream(user, n, ms) {
  let first;
  const started = new Promise((resolve) => {
    first = resolve;
  });
  const done = (async () => {
    const response = await fetch(base + "/u/" + user + "/stream?n=" + n + "&ms=" + ms);
    assert.equal(response.status, 200);
    const events = [];
    let buffered = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffered.indexOf("\n\n")) !== -1) {
        const frame = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) {
          const event = JSON.parse(data.slice(6));
          assert.equal(frame.split("\n")[0], "id: " + event.seq);
          events.push(event);
          if (events.length === 1) first(event);
        }
      }
    }
    assert.equal(events.length, n);
    assert.deepEqual(
      events.map((e) => e.seq),
      Array.from({ length: n }, (_, i) => i + 1),
    );
    return events;
  })();
  // Surface startup errors to both consumers.
  done.catch((error) => first(Promise.reject(error)));
  return { started, done };
}
const pass = (message) => console.log("PASS " + message);
test.provider(
  "facet swap",
  (stack) =>
    Effect.gen(function* () {
      const context = yield* Effect.context();
      const deploy = async (version, gatewayRevision) => {
        const result = await Effect.runPromise(
          stack.deploy(resources(version, gatewayRevision)).pipe(Effect.provideContext(context)),
        );
        return result.published.hash;
      };
      yield* Effect.tryPromise(async () => {
        const a = "alice_" + process.pid;
        const b = "bob_" + process.pid;
        const v1 = await deploy("v1");
        const before = await get("/__local/publication");
        const repeated = await deploy("v1");
        assert.equal(repeated, v1);
        assert.deepEqual(await get("/__local/publication"), before);
        pass("unchanged stack redeploy skips R2 upload and KV latest write");
        assert.equal(
          (await fetch(base + "/__local/code", { method: "PUT", body: "bad" })).status,
          404,
        );
        assert.equal(
          (await fetch(base + "/__local/latest", { method: "PUT", body: v1 })).status,
          404,
        );
        pass("old code-execution publication endpoints are removed");
        assert.equal((await get("/u/" + b + "/version")).hash, v1);
        const old = stream(a, 25, 100);
        assert.equal((await old.started).v, "v1");
        const v2 = await deploy("v2");
        assert.notEqual(v2, v1);
        const updated = await get("/__local/publication");
        assert.equal(updated.hash, v2);
        assert.equal(updated.metadata.version, "v2");
        assert.notEqual(updated.metadata.publication, before.metadata.publication);
        assert.notEqual(updated.uploaded, before.uploaded);
        let queuedResolved = false;
        const queued = get("/u/" + a + "/version").then((value) => {
          queuedResolved = true;
          return value;
        });
        await until(async () => {
          const status = await get("/u/" + a + "/__status");
          return status.pending?.hash === v2 && status.queued === 1 && status.inflight === 1;
        });
        assert.equal(queuedResolved, false);
        pass("request during drain is queued, active stream still counted");
        const bob = await get("/u/" + b + "/version");
        assert.equal(bob.hash, v2);
        assert.equal(bob.served, 0);
        assert.equal(queuedResolved, false);
        pass("another user's supervisor updates independently during Alice's drain");
        const oldEvents = await old.done;
        assert(oldEvents.every((event) => event.v === "v1" && event.hash === v1));
        pass("all 25 SSE events finish on v1, without truncation or mixed versions");
        const after = await queued;
        assert.equal(after.hash, v2);
        assert.equal(after.served, 1);
        pass("queued request resumes on v2 and facet SQLite counter survives abort");
        const fresh = stream(a, 3, 10);
        const freshEvents = await fresh.done;
        assert(
          freshEvents.every((event) => event.v === "v2" && event.hash === v2 && event.served === 2),
        );
        pass("fresh SSE stream is entirely v2, counter increments to 2");

        // A cancelled body must also release the drain gate.
        const aborter = new AbortController();
        const response = await fetch(base + "/u/" + a + "/stream?n=100&ms=100", {
          signal: aborter.signal,
        });
        const reader = response.body.getReader();
        await reader.read();
        const v3 = await deploy("v3");
        const cancelledQueue = get("/u/" + a + "/version");
        await until(async () => (await get("/u/" + a + "/__status")).queued === 1);
        aborter.abort();
        try {
          await reader.cancel();
        } catch {}
        const afterCancel = await cancelledQueue;
        assert.equal(afterCancel.hash, v3);
        assert.equal(afterCancel.served, 3);
        pass("client cancellation releases inflight, allows pending v3 swap, preserves SQLite");
        // These calls run inside F and cross two real service-binding boundaries.
        const note = async (user, key, value) => {
          const response = await fetch(
            base + "/u/" + user + "/notes?key=" + encodeURIComponent(key),
            value === undefined ? {} : { method: "PUT", body: value },
          );
          return response;
        };
        const scope = async (user, readOnly) => {
          const response = await fetch(base + "/u/" + user + "/__scope", {
            method: "PUT",
            body: JSON.stringify({ readOnly }),
          });
          assert.equal(response.status, 200, await response.text());
        };
        assert.deepEqual(await (await note(a, "secret", "alice only")).json(), {
          value: "alice only",
          gateway: "g1",
        });
        assert.equal((await (await note(b, "secret")).json()).value, null);
        await note(b, "secret", "bob only");
        assert.equal((await (await note(a, "secret")).json()).value, "alice only");
        assert.equal((await (await note(b, "secret")).json()).value, "bob only");
        for (const key of ["../" + b + "/secret", b + "/secret", "/secret", ""]) {
          assert.equal((await note(a, key)).status, 403);
          assert.equal((await note(a, key, "overwrite")).status, 403);
        }
        pass("facet reads/writes its own scope; other-user and traversal keys cannot escape");

        // Alchemy keeps Api alive, but its local service channel still pins the old Gateway.
        // Record this local-provider limitation rather than claim a transparent refresh.
        const duringGateway = stream(a, 25, 100);
        await duringGateway.started;
        assert.equal(await deploy("v3", "g2"), v3);
        assert.deepEqual(await (await note(a, "secret")).json(), {
          value: "alice only",
          gateway: "g1",
        });
        assert.equal((await duringGateway.done).length, 25);
        pass(
          "gateway redeploy preserves live stream; local binding stays on g1 (known limitation)",
        );

        const drainingScope = stream(a, 12, 100);
        await drainingScope.started;
        await scope(a, true);
        const status = await get("/u/" + a + "/__status");
        assert.equal(status.current.hash, v3);
        assert.equal(status.pending.hash, v3);
        assert.equal(status.current.readOnly, false);
        assert.equal(status.pending.readOnly, true);
        assert.equal(status.inflight, 1);
        let scopeResolved = false;
        const afterScope = note(a, "secret", "must not write").then((response) => {
          scopeResolved = true;
          return response;
        });
        await until(async () => (await get("/u/" + a + "/__status")).queued === 1);
        assert.equal(scopeResolved, false);
        assert.equal((await drainingScope.done).length, 12);
        assert.equal((await afterScope).status, 403);
        assert.equal((await (await note(a, "secret")).json()).value, "alice only");
        assert.equal((await get("/u/" + a + "/version")).hash, v3);
        await scope(b, false);
        assert.equal((await note(b, "secret", "bob still writes")).status, 200);
        await scope(a, false);
        assert.equal((await note(a, "secret", "alice writable again")).status, 200);
        pass("same-version scope swap drains before read-only enforcement; other users unaffected");
        console.log("ALL PASS");
      });
    }),
  { timeout: 90000 },
);
