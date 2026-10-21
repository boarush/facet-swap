import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const port = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
process.env.BASE_URL = "http://127.0.0.1:" + port;
const { deploy, base } = await import("./deploy.mjs");
const log = await open("test-dev.log", "w");
const child = spawn("npm", ["run", "dev", "--", "--stage", "test_" + process.pid], {
  env: { ...process.env, PORT: String(port), CHECK_INTERVAL_MS: "0" },
  detached: true, stdio: ["ignore", log.fd, log.fd],
});
const timeout = setTimeout(() => { console.error("FAIL test deadline exceeded"); stop(); process.exit(1); }, 90000);
function stop() { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
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
  const started = new Promise(resolve => { first = resolve; });
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
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (data) {
          const event = JSON.parse(data.slice(6));
          assert.equal(frame.split("\n")[0], "id: " + event.seq);
          events.push(event);
          if (events.length === 1) first(event);
        }
      }
    }
    assert.equal(events.length, n);
    assert.deepEqual(events.map(e => e.seq), Array.from({ length: n }, (_, i) => i + 1));
    return events;
  })();
  // Surface startup errors to both consumers.
  done.catch(error => first(Promise.reject(error)));
  return { started, done };
}
const pass = message => console.log("PASS " + message);
try {
  await until(async () => {
    try { return (await fetch(base + "/health")).ok; } catch { return false; }
  });
  pass("Alchemy local dev starts without Cloudflare credentials");
  const a = "alice_" + process.pid;
  const b = "bob_" + process.pid;
  const v1 = await deploy("v1");
  assert.equal((await get("/u/" + b + "/version")).hash, v1);
  const old = stream(a, 25, 100);
  assert.equal((await old.started).v, "v1");
  const v2 = await deploy("v2");
  let queuedResolved = false;
  const queued = get("/u/" + a + "/version").then(value => { queuedResolved = true; return value; });
  await until(async () => {
    const status = await get("/u/" + a + "/__status");
    return status.pending === v2 && status.queued === 1 && status.inflight === 1;
  });
  assert.equal(queuedResolved, false);
  pass("request during drain is queued, active stream still counted");
  const bob = await get("/u/" + b + "/version");
  assert.equal(bob.hash, v2);
  assert.equal(bob.served, 0);
  assert.equal(queuedResolved, false);
  pass("another user's supervisor updates independently during Alice's drain");
  const oldEvents = await old.done;
  assert(oldEvents.every(event => event.v === "v1" && event.hash === v1));
  pass("all 25 SSE events finish on v1, without truncation or mixed versions");
  const after = await queued;
  assert.equal(after.hash, v2);
  assert.equal(after.served, 1);
  pass("queued request resumes on v2 and facet SQLite counter survives abort");
  const fresh = stream(a, 3, 10);
  const freshEvents = await fresh.done;
  assert(freshEvents.every(event => event.v === "v2" && event.hash === v2 && event.served === 2));
  pass("fresh SSE stream is entirely v2, counter increments to 2");

  // A cancelled body must also release the drain gate.
  const aborter = new AbortController();
  const response = await fetch(base + "/u/" + a + "/stream?n=100&ms=100", { signal: aborter.signal });
  const reader = response.body.getReader();
  await reader.read();
  const v3 = await deploy("v3");
  const cancelledQueue = get("/u/" + a + "/version");
  await until(async () => (await get("/u/" + a + "/__status")).queued === 1);
  aborter.abort();
  try { await reader.cancel(); } catch {}
  const afterCancel = await cancelledQueue;
  assert.equal(afterCancel.hash, v3);
  assert.equal(afterCancel.served, 3);
  pass("client cancellation releases inflight, allows pending v3 swap, preserves SQLite");
  console.log("ALL PASS");
} catch (error) {
  console.error("FAIL", error);
  console.error("See test-dev.log");
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  stop();
  await log.close();
}
