import assert from "node:assert/strict";

import { test } from "vitest";

import { upgrade, v1 } from "../src/adapters/v1";
import type { ServerEvent } from "../src/contract";
import { codecFor, latest, LATEST, negotiate, supportedVersions } from "../src/protocol";

test("negotiation requires ?v= and rejects missing or unsupported versions", () => {
  assert.equal(LATEST, 2);
  assert.equal(negotiate(null), null);
  assert.equal(negotiate(undefined), null);
  assert.equal(negotiate(""), null);
  assert.equal(negotiate("1"), 1);
  assert.equal(negotiate("2"), 2);
  assert.equal(negotiate("9"), null);
  assert.equal(negotiate("x"), null);
  assert.deepEqual(supportedVersions(), [2, 1]);
  assert.equal(codecFor(1), v1);
  assert.equal(codecFor(2), latest);
  assert.equal(codecFor(9), undefined);
});

test("v1 upgrade renames note.put text to the latest value field", () => {
  assert.deepEqual(upgrade({ type: "note.put", key: "k", text: "hello" }), {
    type: "note.put",
    key: "k",
    value: "hello",
  });
});

test("v1 downgrade is total: every latest event maps to exactly one outcome", () => {
  // One row per latest event type; adding a type must add a row here.
  const table: readonly (readonly [ServerEvent, unknown])[] = [
    [
      { type: "swap-resumed", hash: "h" },
      { kind: "send", event: { type: "swap-resumed", hash: "h" } },
    ],
    [
      { type: "swap-pending", hash: "h" },
      { kind: "send", event: { type: "swap-pending", hash: "h" } },
    ],
    [
      { type: "note.saved", key: "k", revision: 3 },
      { kind: "send", event: { type: "note.saved", key: "k" } },
    ],
    [{ type: "note.conflict", key: "k" }, { kind: "skip" }],
    [{ type: "notes.reset" }, { kind: "close", code: 4426, reason: "upgrade required" }],
  ];
  assert.equal(table.length, 5);
  for (const [event, expected] of table) assert.deepEqual(v1.downgrade(event), expected);
});

test("every translated outcome still validates against the older schema", () => {
  const events: ServerEvent[] = [
    { type: "swap-resumed", hash: "h" },
    { type: "swap-pending", hash: "h" },
    { type: "note.saved", key: "k", revision: 3 },
  ];
  for (const event of events) {
    const outcome = v1.downgrade(event);
    assert.equal(outcome.kind, "send");
    if (outcome.kind === "send") assert.doesNotThrow(() => v1.encodeEvent(outcome.event));
  }
});

test("v1 decode validates the wire format before upgrading", () => {
  assert.deepEqual(v1.decodeClient({ type: "note.put", key: "k", text: "hi" }), {
    type: "note.put",
    key: "k",
    value: "hi",
  });
  // A latest-shaped message is not a valid v1 message.
  assert.equal(v1.decodeClient({ type: "note.put", key: "k", value: "hi" }), null);
  assert.equal(v1.decodeClient({ type: "note.put", key: "k" }), null);
  assert.equal(v1.decodeClient({ type: "note.get", key: "k", text: "hi" }), null);
  assert.equal(v1.decodeClient("note.put"), null);
});

test("latest codec validates and passes messages through untouched", () => {
  assert.deepEqual(latest.decodeClient({ type: "note.put", key: "k", value: "hi" }), {
    type: "note.put",
    key: "k",
    value: "hi",
  });
  // A v1-shaped message fails the latest schema.
  assert.equal(latest.decodeClient({ type: "note.put", key: "k", text: "hi" }), null);
  assert.equal(latest.decodeClient({ type: "note.put", key: "k", value: 3 }), null);
  const event: ServerEvent = { type: "note.saved", key: "k", revision: 1 };
  assert.deepEqual(latest.downgrade(event), { kind: "send", event });
  assert.equal(latest.encodeEvent(event), JSON.stringify(event));
});
