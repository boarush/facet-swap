# Project Review: Self-Updating Services on Durable Object Facets

**Date:** 2026-10-25
**Scope:** README intent, runtime code (`src/`), infrastructure (`infra/`, `alchemy.run.ts`), scripts, and tests.

## Baseline verification

All existing checks pass:

| Command             | Result            |
| ------------------- | ----------------- |
| `npm run check`     | ✅                |
| `npm run lint`      | ✅                |
| `npm run fmt:check` | ✅                |
| `npm test`          | ✅ 21 tests, ~35s |

The prototype does what the README describes: a stable Supervisor drains admitted work, swaps a content-hashed facet, preserves facet storage, scopes capabilities, publishes through Alchemy Actions, proxies alarms, and records bounded swap history.

The findings below are ordered by risk. Most are hardening, productionization, or size/state optimizations rather than corrections to a broken baseline.

---

## Intent recap

- A stable **Supervisor** owns admission, inflight tracking, drain deadlines, durable config, and alarm proxying.
- A versioned **facet** contains application code, loaded by content hash from R2 through Worker Loader.
- Publication is part of the stack: `FacetCode` uploads to R2, then `FacetLatest` writes KV `latest`.
- Updates are lazy, per-user, forward-only, with a drain window and a forced cut at a deadline.
- Facets receive only scoped capabilities (`ScopedNotes`, `Scheduler`), never raw resource bindings.
- Facet SQLite state and the Supervisor's swap log survive replacement.

---

# P0 — Correctness and resilience

## 1. The demo alarm handler is not idempotent

**Location:** `src/app.ts:21-28`

```ts
const count = this.ctx.storage.kv.get<number>("alarms") ?? 0;
this.ctx.storage.kv.put("alarms", count + 1);
this.ctx.storage.kv.put("last-alarm", {
  hash: this.env.HASH,
  scheduled: await this.env.SCHEDULER.getAlarm(),
});
```

If `SCHEDULER.getAlarm()` fails, or the facet is aborted after the first write, the native alarm retry increments `count` again. This contradicts the README's own rule that alarm handlers must be idempotent. The existing fault-injection test throws before the increment, so it does not exercise this case.

**Suggested fix:** pass a stable delivery ID from the Supervisor (the existing alarm token is ideal) and make the writes atomic:

```ts
// Supervisor
deliveryId: scheduled.token, // stable across native retries, new on rearm

// App
const scheduled = await this.env.SCHEDULER.getAlarm();
this.ctx.storage.transactionSync(() => {
  const last = this.ctx.storage.kv.get<{ id: string }>("last-delivery");
  if (info?.deliveryId && last?.id === info.deliveryId) return;
  const count = this.ctx.storage.kv.get<number>("alarms") ?? 0;
  this.ctx.storage.kv.put("alarms", count + 1);
  this.ctx.storage.kv.put("last-delivery", { id: info?.deliveryId });
  this.ctx.storage.kv.put("last-alarm", { hash: this.env.HASH, scheduled, ... });
});
```

Also expose `isRetry`/`retryCount` in `last-alarm` so the demo actually demonstrates the metadata bridge.

## 2. `swap()` clears the drain timer before the commit can fail

**Location:** `src/supervisor.ts:199-227`

`clearTimeout(this.drainTimer)` and `this.drainTimer = undefined` happen before `transactionSync`. If the transaction throws, pending remains persisted but the deadline is gone; a long-running request can then block the update indefinitely.

**Suggested fix:** clear the timer only after a successful commit, or re-arm it in `finally` when the commit fails.

## 3. A failed facet abort leaves committed state serving old code

**Location:** `src/supervisor.ts:235-238`

`ctx.facets.abort()` runs after the new config is committed. If abort throws, `current` says the new hash while the existing facet may still serve the old code, and the next `ctx.facets.get()` can return that stale facet.

**Suggested fix:** persist a `needsAbort` flag in the same transaction as the config commit, then retry the abort before serving the next request/alarm. Alternatively, treat commit + abort as a small state machine rather than a single fire-and-forget call.

## 4. KV failures become request failures and suppress retries

**Location:** `src/version-source.ts:15-27`

`VERSIONS.get()` rejections propagate into `checkForUpdate()` and therefore into every request/alarm, and `lastCheck` is set before the read succeeds.

A transient KV error should not make the service unavailable. Treat a failed check as "no update observed," log it, serve the current version, and retry sooner than the normal interval. Keep a separate signal if alarms should still fail/retry on KV errors.

## 5. Validate and preflight the published code

**Location:** `src/supervisor.ts:167-176`, `src/version-source.ts:34`

The Supervisor stages any truthy `latest` string; `loadApp` then trusts `code/<hash>.js` exists and matches the hash.

A malformed KV value, missing R2 object, or corrupt object commits the swap first and breaks all subsequent requests. The "no rollback" rule makes this worse.

**Suggested fix before staging:**

1. Validate `latest` against `/^[0-9a-f]{64}$/`.
2. `HEAD` the R2 object (cache positive results by hash).
3. Optionally read the object and verify SHA-256 equals the key. The design is content-addressed, so this is a natural integrity check.
4. Only persist pending after validation succeeds. If validation fails, keep serving `current` and record a diagnostic.

This also lets you warm the Loader/R2 object before the drain finishes.

## 6. `ScopedNotes` can fail open if props are missing or corrupt

**Location:** `src/notes.ts:23-25`

```ts
if (this.ctx.props.readOnly) throw new Error("Notes are read-only");
```

Normal loopback props deliver a boolean, but a missing field would silently grant write access. Validate props explicitly and fail closed:

```ts
if (typeof this.ctx.props?.user !== "string" || !/^[0-9a-f]{64}$/.test(this.ctx.props.user))
  throw new Error("Invalid notes scope");
if (typeof this.ctx.props.readOnly !== "boolean") throw new Error("Invalid notes scope");
```

Do the same for `Scheduler`'s `user` prop.

## 7. `/__scope` drains even when nothing changed

**Location:** `src/supervisor.ts:82-88`

The route stages `{ ...target, readOnly: body.readOnly }` unconditionally. Calling it with the current value cuts streams or forces a swap for an idempotent request.

**Suggested fix:**

```ts
if (target.readOnly === body.readOnly) {
  return Response.json({ accepted: true, changed: false, pending: !!this.state.pending });
}
```

## 8. Do not abort a facet during Supervisor construction

**Location:** `src/supervisor.ts:52`, `:235`

`swap(false, true)` always calls `ctx.facets.abort`. On a fresh incarnation there is no facet to abort; an exception here can wedge construction.

Skip the abort for `restartCommit`, or track whether a facet was actually loaded in this incarnation.

---

# P1 — State, schema, and capability hardening

## Use SQL for Supervisor config

`app-config` is a KV blob while swap history is SQL, and `swap()` relies on `transactionSync` spanning both. Move `current`/`pending`/`pendingSince` into a one-row SQL table and update it in the same `transactionSync` as the `swaps` insert.

Benefits:

- Explicit atomicity.
- A clear place for schema migrations.
- No "KV blob shape changed" compatibility problem.
- Easier diagnostics and querying.

## Add a real Supervisor schema migration

**Location:** `src/supervisor.ts:43-50`

`CREATE TABLE IF NOT EXISTS swaps` will not add columns to existing Durable Object storage. If you later add fields (for example `oldReadOnly`, `newReadOnly`, or an interrupted-alarm count), existing DOs will break on insert.

Add a `PRAGMA user_version` migration or use Alchemy's `@alchemy.run/sql` migration utilities. The README already discusses facet migrations; the Supervisor deserves the same forward-only discipline.

## Improve the swap log

The log currently loses information that matters for this demo:

- `oldReadOnly` / `newReadOnly` for scope swaps.
- `abortedAlarms` / interrupted handlers (`abortedStreams` excludes alarms).
- Optionally the observed publication label/version.

This makes the history much more useful when debugging a scope revocation or a forced alarm retry.

## Test the capability surface, not just the happy path

The README claims a facet cannot reach the unscoped gateway. The integration test covers `NOTES.get/put/revision`, key traversal, and user isolation, but not:

- `env.NOTES.fetch(...)` / `env.SCHEDULER.fetch(...)` on the specialized stubs.
- Missing or corrupt props.
- Whether the stub can reach the entry Worker's default fetch or another named entrypoint.

Add these tests. If `fetch` is exposed on the stub, explicitly deny it or verify that workerd rejects it.

## Add loader sandbox limits and flags

**Location:** `src/version-source.ts:36-46`

The loader code sets only `compatibilityDate`, `mainModule`, `modules`, `env`, and `globalOutbound: null`. Consider:

```ts
compatibilityFlags: ["no_nodejs_compat"],
limits: { cpuMs: 50, subRequests: 10 }, // tune
```

This matches the stack Workers' `no_nodejs_compat` flag and adds basic per-facet resource bounds. It still is not a hardened multi-tenant sandbox, but it narrows the surface.

## Map `/notes` errors correctly

**Location:** `src/app.ts:72-74`

Every failure becomes `403` and the response body is `String(error)`. An R2/gateway outage is not a permission error and leaks internals.

Use typed errors from `ScopedNotes` (invalid key, read-only) and map only those to 403; propagate or map infrastructure failures to 502/500.

## Guard against stale KV downgrades in production

KV is eventually consistent. A stale read can return an older `latest` hash, which the Supervisor would currently accept as a pending downgrade because it only compares inequality with `current` and `pending`.

The local KV does not reproduce this. For production, add a monotonic publication generation (or a strongly consistent version registry) and ignore older reads. At minimum, document this consequence explicitly in the README's limits section.

---

# P2 — Performance and bundle/state optimizations

## 1. Stop storing the full facet bundle in Alchemy Action state

**Location:** `infra/facet.ts:44`

`FacetCode` receives `{ code, hash }`. The generated `.alchemy/state/FacetSwap/<stage>/FacetCode.json` currently contains the entire ~65 KB unminified bundle as the Action input. This grows with application size and slows state reads and diffs.

Options:

- Minify the facet bundle (also reduces R2 size and module parse time).
- Key the Action on `{ hash }` and read the code from a content-addressed local artifact/file.
- Store the bundle as a dedicated Alchemy asset/resource and pass its reference.

Keep a fast unit test asserting the hash is stable and equals SHA-256 of the emitted code.

## 2. Use `hono/tiny`

The Api and facet bundles both include Hono's full router set (visible in `.alchemy/bundles/.../worker.js`). Since the routing needs are simple, `import { Hono } from "hono/tiny"` should cut both bundles substantially. Re-run the routing regression tests after switching.

## 3. Prefetch and verify the next module when staging

When `latest` changes, the Supervisor could call `loadApp()` for the new hash/scope to warm the Worker Loader and R2 read before the drain completes. This reduces post-swap latency and doubles as a loadability check. Cache only successful results.

## 4. Reduce retry churn

**Location:** `src/supervisor.ts:97`

The 503 gate always returns `Retry-After: 1`. During a 30-second drain, that is up to 30 polls per client. Consider returning the remaining drain budget, or a capped value such as `min(5, remaining)`, and document jitter guidance. If you keep `1`, document the trade-off.

## 5. Add caching headers consistently

`/version`, `/notes`, `/alarm`, `/__status`, `/swaps`, and `/__local/publication` return dynamic data without `Cache-Control: no-store`. Add it. Also consider `retry: 1000` in SSE output and `X-Accel-Buffering: no` for proxies.

## 6. Minor wrapper fixes

**Location:** `src/stream-lifetime.ts`

- Lowercase the content-type before comparing; `"Text/Event-Stream"` currently counts as non-SSE.
- Strip `content-length` when wrapping a potentially modified body.
- Guard `JSON.stringify(signal.reason)` against `undefined`.

## 7. Add basic bounds

- Cap total `/stream` duration (`n * ms`), not only each value.
- Cap note value size.
- Validate `setAlarm` time in the Supervisor and Scheduler as well as the facet.
- Validate `CHECK_INTERVAL_MS`, `DRAIN_DEADLINE_MS`, and `PORT` at stack evaluation. `DRAIN_DEADLINE_MS=NaN` currently becomes an immediate forced swap.

---

# Type safety, tooling, and dependencies

## Tighten TypeScript

The project is strict, but these flags would catch real edges:

- `noUncheckedIndexedAccess`: catches `src/worker.ts:34-36`, `src/stream-lifetime.ts:20`, and many test indexing spots.
- `noImplicitOverride`: `fetch`/`alarm` overrides in `app.ts` and `supervisor.ts`.
- `exactOptionalPropertyTypes`: `drainTimer = undefined`, `runningAlarm = undefined`, and `checking = undefined` need explicit `| undefined`.
- `isolatedModules` for Node type-stripping safety.

Make the Loader env contract explicit:

```ts
// app.ts
export type AppEnv = {
  HASH: string;
  NOTES: Service<ScopedNotes>;
  SCHEDULER: Service<Scheduler>;
};

// version-source.ts
const loaderEnv = { HASH: hash, NOTES: ..., SCHEDULER: ... } satisfies AppEnv;
```

Today `WorkerLoaderWorkerCode.env` is `any`, so a missing or typo'd binding compiles.

## Pin the Cloudflare type/runtime surface

`package.json` uses `@cloudflare/workers-types: ^5.20261018.1`, which currently resolves to `5.20261023.1`, while the provider pins workerd/types `5.20261012.1`. TypeScript can therefore accept APIs newer than the pinned runtime.

Pin the root `@cloudflare/workers-types` to the provider's version (or upgrade provider, workerd, and types together) and document the invariant.

Also:

- `@types/node` is only present transitively (via Vitest/Vite) but is used directly by scripts/tests. Make it a direct devDependency.
- `typescript: ^7.0.2` drifts while `@effect/tsgo` patches it. Consider pinning TypeScript exactly for reproducibility.

## Close lint guard gaps

`.oxlintrc.json` blocks `**/alchemy.run` but not `**/alchemy.run.ts`, and does not block `alchemy`, `@alchemy.run/cloudflare`, or `node:*` from `src/`.

If the intent is "runtime stays out of infrastructure and Node," add those patterns explicitly.

## Shared module coupling

`src/router.ts` is imported by both the Supervisor/entry Worker and the facet (`src/app.ts`). Editing the router therefore changes the Supervisor bundle, contradicting the README's implication that "application source" edits leave the Supervisor untouched.

Either:

- document that only `src/app.ts` and facet-only modules are hot-swappable, or
- split the facet router from the Supervisor router so shared edits do not restart the stable side.

---

# Tests and documentation

## Test isolation

`test/facet.test.ts` rewrites `src/app.ts` at runtime. Vitest runs test files in parallel by default, so another worker importing `src/app.ts` could read the modified source. It also leaves the file modified if the process is killed.

Consider:

- `fileParallelism: false` for the integration suite, or a separate project/pool.
- An `afterAll` restore in addition to `finally`.
- A less brittle source mutation than exact-string replacement; assert the replacement actually changed the file.

## Split fast and integration tests

Add `test:unit` (routing, supervisor, stream-lifetime, deploy CLI, bundle/hash unit) and `test:integration` (the Alchemy facet suite). This lets normal CI run in seconds and keeps the expensive local-provider test explicit.

## Add fast invariant tests

- `bundleFacet` emits one file whose `hash === sha256(code)` and is deterministic.
- `loaderKey(hash, user, readOnly)` differs by each field.
- `ScopedNotes` rejects missing or invalid props.
- `swap` re-arms the deadline if the transaction throws.
- A KV check failure does not fail the request.
- An alarm delivery ID prevents double-counting on retry.

## Replace fixed delays with polling

Several integration assertions use fixed `delay(2200)` or similar. The alarm-drain cases are especially timing-sensitive. Prefer the existing `until()` helper for count/hash convergence.

## Documentation drift and additions

- README line 222 claims "a separate watchdog for the full test run"; only a per-test `timeout: 90000` and `hookTimeout` exist. Fix the claim or add the watchdog.
- Document `CHECK_INTERVAL_MS=0` alongside `DRAIN_DEADLINE_MS=3000` in the test section.
- Add a failure-modes table: KV down, R2 code missing, abort failure, storage transaction failure, client disconnect, Supervisor restart.
- Add an env-var/default table.
- Note the stale-KV downgrade risk in production.
- Note that `router.ts` changes affect the Supervisor bundle.
- Note that the `FacetCode` Action state contains the full bundle; document the minify/artifact option.

---

# Suggested order of work

## Quick wins

1. Fix alarm idempotency with a delivery ID.
2. Skip `/__scope` when unchanged.
3. Re-arm the drain timer on commit failure; handle abort failure.
4. Add `Cache-Control: no-store`, SSE `retry`, content-type lowercase, content-length strip.
5. Validate env durations and alarm times.
6. Pin `@cloudflare/workers-types`, add `@types/node`, enable `noImplicitOverride`.
7. Switch to `hono/tiny` and minify the facet bundle.
8. Fix README watchdog drift.

## Larger, high-value work

1. SQL-backed Supervisor config with `PRAGMA user_version` migrations.
2. KV error tolerance, hash validation, and R2 preflight/verification.
3. Fail-closed prop validation and capability-surface tests.
4. Loader `limits` and `no_nodejs_compat`.
5. Split unit/integration tests and serialize source-mutating tests.
6. Monotonic publication generation for production-safe forward-only updates.

---

## Verified as correct

The following parts of the design are internally consistent and well covered by tests:

- Drain admission: new requests receive 503 with retry and version headers; in-flight bodies continue.
- Deadline force swap: SSE bodies receive a final `update-abort` event; non-SSE bodies error; waiting fetches get a retryable 503.
- Facet SQLite state survives abort/replacement.
- Scope-only drains use the same deadline and enforce the new permission after replacement.
- Alarm schedule survives facet swaps; native retries are used; `getAlarm()` semantics during delivery match the README.
- Swap history is atomic with the config commit, bounded to 100 rows, and records normal, forced, scope, and restart commits.
- Scoped notes isolate users and reject traversal keys.
- Encoded path forwarding and 404/405 behavior are preserved.
- The gateway Worker has no HTTP routes and remains out of the Hono dependency.
