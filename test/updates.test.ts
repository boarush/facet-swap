import assert from "node:assert/strict";

import { afterEach, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { FacetUpdates } = await import("../src/updates");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function harness(interval = 100) {
  const latest = vi.fn<() => Promise<{ hash: string; generation: number }>>(async () => ({
    hash: "new",
    generation: 2,
  }));
  const pending = vi.fn<(scope: unknown, hash: string) => Promise<boolean>>(async (_hash) => true);
  const ready = vi.fn<(scope: unknown) => Promise<void>>(async () => {});
  const onUpdate = vi.fn<(hash: string) => Promise<void>>(async (_hash) => {});
  const updates = new FacetUpdates(
    { VERSIONS: { latest }, SWAP: { pending, ready } } as unknown as ConstructorParameters<
      typeof FacetUpdates
    >[0],
    { supervisorId: "user", facet: "app" },
    "old",
    interval,
    onUpdate,
    { getWebSockets: () => [] },
  );
  return { updates, latest, pending, ready, onUpdate };
}

test("facet update checks throttle, share concurrent work and notify only accepted targets", async () => {
  vi.useFakeTimers();
  const h = harness();
  await Promise.all([h.updates.check(), h.updates.check()]);
  assert.equal(h.latest.mock.calls.length, 1);
  assert.deepEqual(h.pending.mock.calls, [[{ supervisorId: "user", facet: "app" }, "new"]]);
  assert.deepEqual(h.onUpdate.mock.calls, [["new"]]);
  await h.updates.check();
  assert.equal(h.latest.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(100);
  await h.updates.check();
  assert.equal(h.latest.mock.calls.length, 2);
  assert.equal(h.onUpdate.mock.calls.length, 1);
  await h.updates.ready();
  assert.deepEqual(h.ready.mock.calls, [[{ supervisorId: "user", facet: "app" }]]);
});

test("facet retries failures and rejected publications without notifying the app", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = harness(0);
  h.latest.mockRejectedValueOnce(new Error("KV unavailable"));
  await h.updates.check();
  assert.equal(h.pending.mock.calls.length, 0);
  h.pending.mockResolvedValueOnce(false);
  await h.updates.check();
  assert.equal(h.onUpdate.mock.calls.length, 0);
  await h.updates.check();
  assert.equal(h.onUpdate.mock.calls.length, 1);
});

test("unchanged facet hash does not request a swap", async () => {
  const h = harness();
  h.latest.mockResolvedValueOnce({ hash: "old", generation: 3 });
  await h.updates.check();
  assert.equal(h.pending.mock.calls.length, 0);
});

test("readiness closes every socket with 1012 before notifying the Supervisor", async () => {
  const calls: string[] = [];
  const close = vi.fn<(code: number, reason: string) => void>((code, reason) => {
    assert.equal(code, 1012);
    assert.equal(reason, "service restart");
    calls.push("close");
  });
  const updates = new FacetUpdates(
    {
      VERSIONS: {},
      SWAP: {
        ready: async () => {
          calls.push("ready");
        },
      },
    } as unknown as ConstructorParameters<typeof FacetUpdates>[0],
    { supervisorId: "user", facet: "app" },
    "old",
    0,
    () => {},
    {
      getWebSockets: () =>
        [
          {
            close: () => {
              throw new Error("disconnected");
            },
          },
          { close },
        ] as unknown as WebSocket[],
    },
  );
  await updates.ready();
  assert.deepEqual(calls, ["close", "ready"]);
});
