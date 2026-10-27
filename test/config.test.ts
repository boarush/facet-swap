import assert from "node:assert/strict";

import * as Effect from "effect/Effect";
import { afterEach, test, vi } from "vitest";

import { milliseconds } from "../alchemy.run";

afterEach(() => vi.unstubAllEnvs());

const read = (values: Record<string, string>, fallback = "10000") => {
  vi.stubEnv("CHECK_INTERVAL_MS", values.CHECK_INTERVAL_MS);
  return milliseconds("CHECK_INTERVAL_MS", fallback);
};

test("millisecond configuration reads the environment when executed", () => {
  const config = milliseconds("CHECK_INTERVAL_MS", "10000");
  vi.stubEnv("CHECK_INTERVAL_MS", "200");
  assert.equal(Effect.runSync(config), "200");
  vi.stubEnv("CHECK_INTERVAL_MS", "300");
  assert.equal(Effect.runSync(config), "300");
});

test("millisecond configuration defaults only when absent", () => {
  assert.equal(Effect.runSync(read({})), "10000");
  assert.equal(Effect.runSync(read({}, "30000")), "30000");
  assert.equal(Effect.runSync(read({ CHECK_INTERVAL_MS: "0" })), "0");
});

test("millisecond configuration preserves valid strings through the timer limit", () => {
  for (const value of ["1", "500", "00010", String(2 ** 31 - 1)]) {
    assert.equal(Effect.runSync(read({ CHECK_INTERVAL_MS: value })), value);
  }
});

test("invalid millisecond configuration is an Effect failure with the key and value", () => {
  for (const value of [
    "",
    " ",
    "-1",
    "+1",
    "1.5",
    "1e3",
    "NaN",
    "Infinity",
    "oops",
    String(2 ** 31),
  ]) {
    const error = Effect.runSync(Effect.flip(read({ CHECK_INTERVAL_MS: value })));
    assert.match(error.message, /CHECK_INTERVAL_MS must be a whole number of milliseconds/);
    assert(error.message.includes(JSON.stringify(value)));
  }
});
