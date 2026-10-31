import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { toFqn } from "alchemy/FQN";
import { CurrentNamespace } from "alchemy/Namespace";
import { State } from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";

import { bundleFacet, resources } from "../alchemy.run.ts";
import type { UpdateAbort } from "../src/stream-lifetime";

const port = await new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    server.close(() => resolve(port));
  });
});
const base = "http://127.0.0.1:" + port;
process.env.PORT = String(port);
process.env.CHECK_INTERVAL_MS = "0";
process.env.DRAIN_DEADLINE_MS = "3000";
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  stage: "test_" + process.pid,
});
type Version = { v: string; hash: string; label?: string; served: number };
type StreamEvent = Version & { seq: number; msg: string };
type Config = { hash: string; generation: number; readOnly: boolean };
type Status = {
  current: Config | null;
  pending: Config | null;
  pendingSince: number | null;
  swaps: Swap[];
  inflight: number;
  swapping: boolean;
  facets: { name: string; createdAt: number; loadedHash: string; loadedAt: number }[];
};
type Swap = {
  oldHash: string | null;
  newHash: string;
  kind: "code" | "scope";
  pendingSince: number;
  swappedAt: number;
  forced: boolean;
  abortedStreams: number;
  restartCommit: boolean;
};
type Publication = {
  hash: string | null;
  generation: number;
  metadata: { version: string; publication: string } | null;
  uploaded?: string;
};
type Alarm = {
  scheduled: number | null;
  count: number;
  last: { hash: string; scheduled: number | null } | null;
};

async function get<T = Version>(path: string): Promise<T> {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json<T>();
}
async function until(fn: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(20);
  }
  throw new Error("Condition timed out");
}
function stream(user: string, n: number, ms: number, expectAbort = false) {
  let first!: (event: StreamEvent) => void;
  let rejectStarted!: (reason: unknown) => void;
  const started = new Promise<StreamEvent>((resolve, reject) => {
    first = resolve;
    rejectStarted = reject;
  });
  const done = (async () => {
    const response = await fetch(base + "/u/" + user + "/stream?n=" + n + "&ms=" + ms);
    assert.equal(response.status, 200);
    const events: StreamEvent[] = [];
    let updateAbort: UpdateAbort | undefined;
    let buffered = "";
    const decoder = new TextDecoder();
    assert(response.body);
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffered.indexOf("\n\n")) !== -1) {
        const frame = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) {
          const parsed: unknown = JSON.parse(data.slice(6));
          if (frame.includes("event: update-abort")) {
            assert.equal(updateAbort, undefined);
            updateAbort = parsed as UpdateAbort;
            continue;
          }
          const event = parsed as StreamEvent;
          assert.equal(updateAbort, undefined, "no source events after update-abort");
          assert.equal(frame.split("\n")[0], "id: " + event.seq);
          events.push(event);
          if (events.length === 1) first(event);
        }
      }
    }
    if (expectAbort) {
      assert(updateAbort, "stream must end with update-abort");
      assert(events.length < n, "deadline must truncate the old stream");
    } else {
      assert.equal(updateAbort, undefined, "normal stream must not be cut");
      assert.equal(events.length, n);
    }
    assert.deepEqual(
      events.map((e) => e.seq),
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
    return { events, updateAbort };
  })();
  // Surface startup errors to both consumers.
  void done.catch(rejectStarted);
  return { started, done };
}
async function rejectedDuringDrain(
  path: string,
  current: string,
  pending: string,
  init?: RequestInit,
) {
  const response = await fetch(base + path, init);
  assert.equal(response.status, 503, await response.text());
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal(response.headers.get("X-Current-Version"), current);
  assert.equal(response.headers.get("X-Pending-Version"), pending);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
}
const pass = (message: string) => console.log("PASS " + message);
test.provider(
  "facet swap",
  (stack) =>
    Effect.gen(function* () {
      const context = yield* Effect.context();
      const deploy = async (version: string, gatewayRevision?: string) => {
        const result = await Effect.runPromiseWith(context)(
          // Alchemy beta.84 exposes a broad deployment error channel.
          // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
          stack.deploy(resources(version, gatewayRevision)),
        );
        return result.published.hash;
      };
      yield* Effect.tryPromise(async () => {
        const a = "alice_" + process.pid;
        const b = "bob_" + process.pid;
        const unlabelled = await deploy("");
        const initial = await get("/u/unlabelled_" + process.pid + "/version");
        assert.equal(initial.hash, unlabelled);
        assert.equal(initial.v, unlabelled.slice(0, 12));
        assert.equal(Object.hasOwn(initial, "label"), false);
        pass("no manual label needed; clients see a short content hash");

        const diagnosticUser = "/u/unlabelled_" + process.pid;
        for (const path of [
          "/health",
          "/__local/publication",
          diagnosticUser + "/__status",
          diagnosticUser + "/version",
          diagnosticUser + "/stream",
        ]) {
          const head = await fetch(base + path, { method: "HEAD" });
          assert.equal(head.status, 200, path);
          assert.equal(await head.text(), "");
          for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
            const response = await fetch(base + path, { method });
            assert.equal(response.status, 405, path + " " + method);
            assert.equal(await response.text(), "Method not allowed");
          }
        }
        assert.equal((await get<Status>(diagnosticUser + "/__status?swaps=0")).inflight, 0);
        assert.deepEqual((await get<Status>(diagnosticUser + "/__status?swaps=0")).swaps, []);
        const loaded = await get<Status>(diagnosticUser + "/__status?swaps=0");
        assert.deepEqual(
          loaded.facets.map(({ name, loadedHash }) => ({ name, loadedHash })),
          [{ name: "app", loadedHash: loaded.current!.hash }],
        );
        assert.equal((await fetch(base + diagnosticUser + "/__status?swaps=-1")).status, 400);
        assert.equal((await fetch(base + diagnosticUser + "/swaps")).status, 404);
        pass("diagnostics are GET/HEAD only; status includes optional swap history");

        const v1 = await deploy("v1");
        assert.notEqual(v1, unlabelled);
        const before = await get<Publication>("/__local/publication");
        const repeated = await deploy("v1");
        assert.equal(repeated, v1);
        assert.deepEqual(await get<Publication>("/__local/publication"), before);
        pass("unchanged stack redeploy skips R2 upload and KV latest write");
        const saved = JSON.stringify(
          await Effect.runPromiseWith(context)(
            Effect.gen(function* () {
              // State is installed by Stack.make but omitted from its public services type.
              const state = yield* Effect.serviceOption(State);
              if (state._tag === "None") throw new Error("Missing stack state store");
              const store = yield* state.value;
              const { name, stage } = stack;
              const fqn = toFqn(yield* CurrentNamespace, "FacetCode");
              return yield* store.get({ stack: name, stage, fqn });
            }),
          ),
        );
        assert(saved.includes(v1) && !saved.includes("hello from"));
        pass("upload Action state keeps the hash, not the bundle");
        // Only app source changes; the optional label stays fixed.
        const sourceUser = "source_" + process.pid;
        assert.equal((await get("/u/" + sourceUser + "/version")).hash, v1);
        const appPath = new URL("../src/app.ts", import.meta.url);
        const originalSource = await readFile(appPath, "utf8");
        try {
          await writeFile(appPath, originalSource.replace('"hello from "', '"source edit from "'));
          const sourceHash = await deploy("v1");
          assert.notEqual(sourceHash, v1);
          const publication = await get<Publication>("/__local/publication");
          assert.equal(publication.hash, sourceHash);
          assert.notEqual(publication.metadata!.publication, before.metadata!.publication);
          assert(publication.generation > before.generation);
          const sourceEvent = (await stream(sourceUser, 1, 0).done).events[0];
          assert.equal(sourceEvent.hash, sourceHash);
          assert.equal(sourceEvent.v, sourceHash.slice(0, 12));
          assert.equal(sourceEvent.label, "v1");
          assert.equal(sourceEvent.msg, "source edit from " + sourceHash.slice(0, 12));
          assert.equal(await deploy("v1"), sourceHash);
          assert.deepEqual(await get<Publication>("/__local/publication"), publication);
          pass("source-only edit publishes and swaps with unchanged label; repeat is a no-op");
        } finally {
          await writeFile(appPath, originalSource);
        }
        assert.equal(await deploy("v1"), v1);

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
        assert.equal((await old.started).label, "v1");
        const v2 = await deploy("v2");
        assert.notEqual(v2, v1);
        const updated = await get<Publication>("/__local/publication");
        assert.equal(updated.hash, v2);
        assert(updated.generation > before.generation);
        assert.equal(updated.metadata!.version, "v2");
        assert.notEqual(updated.metadata!.publication, before.metadata!.publication);
        assert.notEqual(updated.uploaded, before.uploaded);
        await rejectedDuringDrain("/u/" + a + "/version", v1, v2);
        const draining = await get<Status>("/u/" + a + "/__status");
        assert.equal(draining.pending!.hash, v2);
        assert.equal(draining.current!.hash, v1);
        assert.equal(draining.inflight, 1);
        pass(
          "request during drain gets 503 with retry/version headers, active stream still counted",
        );
        const bob = await get("/u/" + b + "/version");
        assert.equal(bob.hash, v2);
        assert.equal(bob.served, 0);
        pass("another user's supervisor updates independently during Alice's drain");
        const { events: oldEvents } = await old.done;
        assert(oldEvents.every((event) => event.label === "v1" && event.hash === v1));
        pass("all 25 SSE events finish on v1, without truncation or mixed versions");
        await until(async () => (await get<Status>("/u/" + a + "/__status")).pending === null);
        const history = await get<Status>("/u/" + a + "/__status?swaps=1");
        assert.equal(history.swaps.length, 1);
        assert.equal(history.swaps[0].oldHash, v1);
        assert.equal(history.swaps[0].newHash, v2);
        assert.equal(history.swaps[0].kind, "code");
        assert.equal(history.swaps[0].forced, false);
        assert.equal(history.swaps[0].abortedStreams, 0);
        assert.equal(history.swaps[0].restartCommit, false);
        assert(history.swaps[0].swappedAt >= history.swaps[0].pendingSince);
        const after = await get("/u/" + a + "/version");
        assert.equal(after.hash, v2);
        assert.equal(after.served, 1);
        pass("retry succeeds on v2 and facet SQLite counter survives abort");
        const fresh = stream(a, 3, 10);
        const { events: freshEvents } = await fresh.done;
        assert(
          freshEvents.every(
            (event) => event.label === "v2" && event.hash === v2 && event.served === 2,
          ),
        );
        pass("fresh SSE stream is entirely v2, counter increments to 2");

        // A cancelled body must also release the drain gate.
        const aborter = new AbortController();
        const response = await fetch(base + "/u/" + a + "/stream?n=100&ms=100", {
          signal: aborter.signal,
        });
        assert(response.body);
        const reader = response.body.getReader();
        await reader.read();
        const v3 = await deploy("v3");
        await rejectedDuringDrain("/u/" + a + "/version", v2, v3);
        assert.equal((await get<Status>("/u/" + a + "/__status")).inflight, 1);
        aborter.abort();
        try {
          await reader.cancel();
        } catch {}
        await until(async () => {
          const status = await get<Status>("/u/" + a + "/__status");
          return status.pending === null && status.inflight === 0 && status.current!.hash === v3;
        });
        const afterCancel = await get("/u/" + a + "/version");
        assert.equal(afterCancel.hash, v3);
        assert.equal(afterCancel.served, 3);
        pass("client cancellation releases inflight, allows pending v3 swap, preserves SQLite");
        // Both facets share one loader hash, but their props carry distinct capabilities.
        assert.equal((await get("/u/" + a + "/version")).hash, v3);
        assert.equal((await get("/u/" + b + "/version")).hash, v3);
        // These calls run inside F and cross two real service-binding boundaries.
        const note = async (user: string, key: string, value?: string) => {
          const response = await fetch(
            base + "/u/" + user + "/notes?key=" + encodeURIComponent(key),
            value === undefined ? {} : { method: "PUT", body: value },
          );
          return response;
        };
        const scope = async (user: string, readOnly: boolean) => {
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
        assert.equal(
          (await (await note(b, "secret")).json<{ value: string | null }>()).value,
          null,
        );
        await note(b, "secret", "bob only");
        assert.equal(
          (await (await note(a, "secret")).json<{ value: string | null }>()).value,
          "alice only",
        );
        assert.equal(
          (await (await note(b, "secret")).json<{ value: string | null }>()).value,
          "bob only",
        );
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
        assert.equal((await duringGateway.done).events.length, 25);
        pass(
          "gateway redeploy preserves live stream; local binding stays on g1 (known limitation)",
        );

        const drainingScope = stream(a, 12, 100);
        await drainingScope.started;
        await scope(a, true);
        const status = await get<Status>("/u/" + a + "/__status");
        assert.equal(status.current!.hash, v3);
        assert.equal(status.pending!.hash, v3);
        assert.equal(status.current!.readOnly, false);
        assert.equal(status.pending!.readOnly, true);
        assert.equal(status.pending!.generation, status.current!.generation);
        assert.equal(status.inflight, 1);
        await rejectedDuringDrain("/u/" + a + "/notes?key=secret", v3, v3, {
          method: "PUT",
          body: "must not write",
        });
        assert.equal((await note(b, "secret", "bob still writes")).status, 200);
        assert.equal((await get<Status>("/u/" + a + "/__status")).inflight, 1);
        assert.equal((await drainingScope.done).events.length, 12);
        await until(async () => (await get<Status>("/u/" + a + "/__status")).pending === null);
        assert.equal((await note(a, "secret", "must not write")).status, 403);
        assert.equal(
          (await (await note(a, "secret")).json<{ value: string | null }>()).value,
          "alice only",
        );
        assert.equal((await get("/u/" + a + "/version")).hash, v3);
        await scope(b, false);
        assert.equal((await note(b, "secret", "bob still writes")).status, 200);
        await scope(a, false);
        assert.equal((await note(a, "secret", "alice writable again")).status, 200);
        pass("same-version scope swap drains before read-only enforcement; other users unaffected");
        const overdue = stream(a, 100, 1000, true);
        await overdue.started;
        const v4 = await deploy("v4", "g2");
        const pendingAt = Date.now();
        await rejectedDuringDrain("/u/" + a + "/version", v3, v4);
        const forced = await overdue.done;
        assert.deepEqual(forced.updateAbort, {
          reason: "drain-deadline",
          oldVersion: v3,
          newVersion: v4,
        });
        assert(forced.events.every((event) => event.hash === v3));
        assert(Date.now() - pendingAt >= Number(process.env.DRAIN_DEADLINE_MS) - 100);
        assert(Date.now() - pendingAt < Number(process.env.DRAIN_DEADLINE_MS) + 2000);
        const deadlineLog = (await get<Status>("/u/" + a + "/__status?swaps=1")).swaps[0];
        assert.equal(deadlineLog.oldHash, v3);
        assert.equal(deadlineLog.newHash, v4);
        assert.equal(deadlineLog.kind, "code");
        assert.equal(deadlineLog.forced, true);
        assert.equal(deadlineLog.abortedStreams, 1);
        assert.equal(deadlineLog.restartCommit, false);
        assert(deadlineLog.swappedAt - deadlineLog.pendingSince >= 3000);
        const afterDeadline = await get("/u/" + a + "/version");
        assert.equal(afterDeadline.hash, v4);
        assert.equal((await get<Status>("/u/" + a + "/__status")).inflight, 0);
        const { events: nextStream } = await stream(a, 3, 10).done;
        assert(nextStream.every((event) => event.hash === v4));
        assert.equal(nextStream[0].served, afterDeadline.served + 1);
        pass("deadline emits final update-abort, cuts old facet, retry and fresh stream use v4");

        const overdueScope = stream(a, 100, 1000, true);
        await overdueScope.started;
        await scope(a, true);
        await rejectedDuringDrain("/u/" + a + "/notes?key=secret", v4, v4, {
          method: "PUT",
          body: "must not write",
        });
        const forcedScope = await overdueScope.done;
        assert.deepEqual(forcedScope.updateAbort, {
          reason: "drain-deadline",
          oldVersion: v4,
          newVersion: v4,
        });
        assert.equal((await note(a, "secret", "must not write")).status, 403);
        const scopeLog = (await get<Status>("/u/" + a + "/__status?swaps=1")).swaps[0];
        assert.equal(scopeLog.oldHash, v4);
        assert.equal(scopeLog.newHash, v4);
        assert.equal(scopeLog.kind, "scope");
        assert.equal(scopeLog.forced, true);
        assert.equal(scopeLog.abortedStreams, 1);
        assert.equal((await get<Status>("/u/" + a + "/__status")).inflight, 0);
        pass("same-version scope drain has the same hard deadline and enforces new permission");
        const alarmUser = "alarm_" + process.pid;
        const alarmPath = "/u/" + alarmUser + "/alarm";
        const schedule = async (time: number) => {
          const response = await fetch(base + alarmPath, {
            method: "PUT",
            body: JSON.stringify({ time }),
          });
          assert.equal(response.status, 200, await response.clone().text());
          assert.equal((await response.json<{ scheduled: number | null }>()).scheduled, time);
        };
        assert.deepEqual(await get<Alarm>(alarmPath), { scheduled: null, count: 0, last: null });
        const otherAlarmPath = "/u/" + b + "/alarm";
        const isolatedAt = Date.now() + 60000;
        await schedule(isolatedAt);
        assert.equal((await get<Alarm>(otherAlarmPath)).scheduled, null);
        await fetch(base + otherAlarmPath, { method: "DELETE" });
        assert.equal((await get<Alarm>(alarmPath)).scheduled, isolatedAt);
        const cancelledAt = Date.now() + 300;
        await schedule(cancelledAt);
        const deleted = await fetch(base + alarmPath, { method: "DELETE" });
        assert.equal(deleted.status, 200);
        assert.equal((await deleted.json<{ scheduled: number | null }>()).scheduled, null);
        await delay(400);
        assert.equal((await get<Alarm>(alarmPath)).count, 0);
        await schedule(Date.now() + 200);
        await until(async () => (await get<Alarm>(alarmPath)).count === 1);
        assert.deepEqual(await get<Alarm>(alarmPath), {
          scheduled: null,
          count: 1,
          last: { hash: v4, scheduled: null },
        });
        pass("facet scheduler set/get/delete uses real alarms; handler sees no pending delivery");

        // No application request to this Supervisor between publication and firing.
        // The alarm itself must notice latest code and preserve the due time across abort.
        await schedule(Date.now() + 2000);
        const v5 = await deploy("v5", "g2");
        await delay(2200);
        const swappedAlarm = await get<Alarm>(alarmPath);
        assert.equal(swappedAlarm.count, 2);
        assert.deepEqual(swappedAlarm.last, { hash: v5, scheduled: null });
        assert.equal(swappedAlarm.scheduled, null);
        pass("an alarm wakes on latest code without traffic; its schedule survives facet swap");

        await schedule(Date.now() + 1000);
        const alarmDrain = stream(alarmUser, 25, 100);
        await alarmDrain.started;
        const v6 = await deploy("v6", "g2");
        await rejectedDuringDrain("/u/" + alarmUser + "/version", v5, v6);
        await delay(1200);
        assert.equal((await get<Status>("/u/" + alarmUser + "/__status")).pending!.hash, v6);
        await alarmDrain.done;
        await until(async () => (await get<Alarm>(alarmPath)).count === 3);
        assert.deepEqual((await get<Alarm>(alarmPath)).last, { hash: v6, scheduled: null });
        pass("alarm due during a normal drain defers and runs only after swap on new code");

        await schedule(Date.now() + 1000);
        const forcedAlarmDrain = stream(alarmUser, 100, 1000, true);
        await forcedAlarmDrain.started;
        const v7 = await deploy("v7", "g2");
        await rejectedDuringDrain("/u/" + alarmUser + "/version", v6, v7);
        const forcedAlarm = await forcedAlarmDrain.done;
        assert.equal(forcedAlarm.updateAbort?.newVersion, v7);
        await until(async () => (await get<Alarm>(alarmPath)).count === 4);
        assert.deepEqual((await get<Alarm>(alarmPath)).last, { hash: v7, scheduled: null });
        pass("drain deferrals leave the hard deadline intact and deliver after forced swap");
        // Fault injection stays in the test bundle, not in the demo's alarm API.
        const alarmSource = await readFile(appPath, "utf8");
        try {
          await writeFile(
            appPath,
            alarmSource.replace(
              "async alarm(_info?: AlarmInvocationInfo): Promise<void> {",
              'async alarm(_info?: AlarmInvocationInfo): Promise<void> { if (!_info?.isRetry) throw new Error("test alarm retry");',
            ),
          );
          const retryHash = await deploy("alarm-retry", "g2");
          await schedule(Date.now() + 100);
          await until(async () => (await get<Alarm>(alarmPath)).count === 5);
          assert.deepEqual((await get<Alarm>(alarmPath)).last, {
            hash: retryHash,
            scheduled: null,
          });
          pass("facet exception reaches native retry; serializable retry metadata reaches handler");
        } finally {
          await writeFile(appPath, alarmSource);
        }
        const stableHash = await deploy("preflight-base", "g2");
        const preflightUser = "preflight_" + process.pid;
        const versionPath = "/u/" + preflightUser + "/version";
        assert.equal((await get(versionPath)).hash, stableHash);
        const stablePublication = await get<Publication>("/__local/publication");
        const nextBundle = await Effect.runPromiseWith(context)(bundleFacet("preflight-next"));
        const inject = async (hash: string, generation: number, code: string | null = null) => {
          await Effect.runPromiseWith(context)(
            // Alchemy beta.84 exposes a broad deployment error channel.
            // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
            stack.deploy(
              Effect.gen(function* () {
                const result = yield* resources("preflight-base", "g2");
                const bucket = yield* Cloudflare.R2.Bucket("Code");
                const namespace = yield* Cloudflare.KV.Namespace("Versions");
                const Inject = Alchemy.Action(
                  "TestPublication",
                  Effect.gen(function* () {
                    const kv = yield* Cloudflare.KV.WriteNamespace(namespace);
                    const r2 = yield* Cloudflare.R2.WriteBucket(bucket);
                    return Effect.fn(function* (input: {
                      hash: string;
                      generation: number;
                      code: string | null;
                      after: string;
                    }) {
                      if (input.code !== null)
                        yield* r2.put("code/" + input.hash + ".js", input.code);
                      yield* kv.put(
                        "latest",
                        JSON.stringify({
                          hash: input.hash,
                          generation: input.generation,
                        }),
                      );
                    });
                  }).pipe(
                    Effect.provide([
                      Cloudflare.KV.WriteNamespaceLocal,
                      Cloudflare.R2.WriteBucketLocal,
                    ]),
                  ),
                );
                yield* Inject({ hash, generation, code, after: result.published.hash });
                return result;
              }),
            ),
          );
        };
        await inject("../bad", stablePublication.generation + 1);
        assert.equal((await get(versionPath)).hash, stableHash);
        await inject(nextBundle.hash, stablePublication.generation + 2);
        assert.equal((await get(versionPath)).hash, stableHash);
        assert.equal((await get<Status>("/u/" + preflightUser + "/__status")).pending, null);
        await inject(nextBundle.hash, stablePublication.generation + 2, nextBundle.code);
        assert.equal((await get(versionPath)).hash, nextBundle.hash);
        await inject("0".repeat(64), stablePublication.generation + 3, "export default {");
        assert.equal((await get(versionPath)).hash, nextBundle.hash);
        await inject(stableHash, stablePublication.generation + 1);
        assert.equal((await get(versionPath)).hash, nextBundle.hash);
        pass(
          "real loader rejects malformed/missing/uncompilable code, retries missing code, ignores stale KV",
        );

        // Ordering comes from KV latest even when the clock stalls/regresses.
        const clock = vi.spyOn(Date, "now").mockReturnValue(8_000_000_000_000_000);
        try {
          await deploy("generation-a", "g2");
          const first = await get<Publication>("/__local/publication");
          await deploy("generation-b", "g2");
          const second = await get<Publication>("/__local/publication");
          assert.equal(second.generation, first.generation + 1);
          clock.mockReturnValue(7_999_999_999_999_000);
          await deploy("generation-a", "g2");
          const third = await get<Publication>("/__local/publication");
          assert.equal(third.generation, second.generation + 1);
          assert.equal(third.hash, first.hash);
          await deploy("generation-a", "g2");
          assert.deepEqual(await get<Publication>("/__local/publication"), third);
          // KV ahead of the Action's output, as after an interrupted publish.
          await inject(third.hash!, third.generation + 100);
          await deploy("generation-b", "g2");
          const fourth = await get<Publication>("/__local/publication");
          assert.equal(fourth.generation, third.generation + 101);
          pass(
            "generation increases with a stalled/regressing clock or lost Action output; unchanged deploy is a no-op",
          );
        } finally {
          clock.mockRestore();
        }
        console.log("ALL PASS");
      });
    }),
  { timeout: 90000 },
);
