import assert from "node:assert/strict";

import { test } from "vitest";

import { trackResponseBody } from "../src/stream-lifetime";

const reason = { reason: "drain-deadline", oldVersion: "old", newVersion: "new" };

test("deadline closes SSE even with an upstream read pending, cancelling its source once", async () => {
  let cancelled: unknown;
  let released = 0;
  const aborter = new AbortController();
  const source = new ReadableStream({
    cancel(value) {
      cancelled = value;
    },
  });
  const response = trackResponseBody(
    new Response(source, { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
    aborter.signal,
    () => released++,
  );
  const body = response.text();
  aborter.abort(reason);
  assert.equal(await body, "\n\nevent: update-abort\ndata: " + JSON.stringify(reason) + "\n\n");
  assert.equal(cancelled, reason);
  assert.equal(released, 1);
});

test("completed body releases once and cannot receive a later abort frame", async () => {
  let released = 0;
  const aborter = new AbortController();
  const response = trackResponseBody(
    new Response("data: done\n\n", { headers: { "content-type": "text/event-stream" } }),
    aborter.signal,
    () => released++,
  );
  assert.equal(await response.text(), "data: done\n\n");
  aborter.abort(reason);
  assert.equal(released, 1);
});

test("non-SSE bodies fail rather than receiving an invalid SSE suffix", async () => {
  let cancelled: unknown;
  let released = 0;
  const aborter = new AbortController();
  const response = trackResponseBody(
    new Response(
      new ReadableStream({
        cancel: (value) => {
          cancelled = value;
        },
      }),
    ),
    aborter.signal,
    () => released++,
  );
  assert(response.body);
  const reader = response.body.getReader();
  const reading = reader.read();
  aborter.abort(reason);
  await assert.rejects(reading, /Drain deadline exceeded/);
  assert.equal(cancelled, reason);
  assert.equal(released, 1);
});

test("client cancellation releases once and forwards cancellation upstream", async () => {
  let cancelled: unknown;
  let released = 0;
  const aborter = new AbortController();
  const response = trackResponseBody(
    new Response(
      new ReadableStream({
        cancel: (value) => {
          cancelled = value;
        },
      }),
    ),
    aborter.signal,
    () => released++,
  );
  assert(response.body);
  await response.body.cancel("client left");
  aborter.abort(reason);
  assert.equal(cancelled, "client left");
  assert.equal(released, 1);
});
