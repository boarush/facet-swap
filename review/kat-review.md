# Kat's Review Notes

Second opinion on [project-review.md](./project-review.md), checked against the source at `99bd949`.

The original review is accurate in most places, but it ranks everything by category rather than by real risk. Below is what I think matters, what I'd skip, and why.

## Worth doing

### 1. Stale KV downgrades (highest value)

KV is eventually consistent per edge location. A Supervisor can read an older `latest` after it has already moved forward, and `checkForUpdate` treats any inequality as an update. The result is a backwards swap, then a forwards one, each with a drain and possibly forced stream cuts. Local KV never shows this.

Fix: publish `{ hash, generation }` where generation increases monotonically, persist the current generation in the Supervisor, and ignore any read whose generation is not greater.

### 2. KV read failures fail requests

`VersionSource.check` propagates a `VERSIONS.get` rejection into every request and alarm. A failed check should mean "no update observed": serve current, retry on the next interval.

### 3. Validate and preflight before staging

The Supervisor stages any truthy `latest`. With no rollback, a malformed value or missing R2 object breaks the service after the swap. Validate the hash format, load the module through the loader (which reads R2 and warms the cache), and only then persist pending. A failed preflight keeps serving current.

### 4. Cheap correctness fixes

- `PUT /__scope` with the current value still drains. Return `changed: false` instead.
- `DRAIN_DEADLINE_MS=NaN` (or `CHECK_INTERVAL_MS`) silently becomes an immediate timer. Validate at stack evaluation.
- Demo alarm handler: `await SCHEDULER.getAlarm()` before the writes, so the synchronous writes commit together. A delivery ID isn't needed for this.
- `@cloudflare/workers-types` floats to `5.20261023.1` while the bundled runtime is `1.20261012.1`. Pin types to the runtime, and pin `typescript` exactly since `@effect/tsgo` patches it.
- `test/facet.test.ts` rewrites `src/app.ts` at runtime. Serialize that file (or the integration suite) and assert the replacement happened.
- Document that `src/router.ts` is shared, so editing it redeploys the Supervisor too.

### 5. Keep the bundle out of Alchemy state

`FacetCode` takes `{ code, hash }` as its Action input, so the whole facet bundle (~65 KB unminified today) is stored in `.alchemy/state/.../FacetCode.json`. It grows with the app and is read and diffed on every deploy, which gets worse with a remote state store. Key the Action on the hash only and read the code from the content-addressed bundle artifact at upload time. Minifying helps size, but doesn't fix the shape.

### 6. Optional polish

`hono/tiny`, minifying the facet bundle, and `Retry-After` derived from the remaining drain budget. Fine, low priority.

## Skip or defer

- **Timer cleared before commit / abort throws / abort in constructor (P0 2, 3, 8).** If `transactionSync` throws, the object's storage is broken and the DO resets anyway. `facets.abort` on an unloaded facet is a no-op path, and `swap` already returns early without a pending config. Mostly theoretical.
- **Move config to SQL.** `ctx.storage.kv` and `sql` share the same SQLite database, so `transactionSync` is already atomic across both. Add `PRAGMA user_version` migrations only when the `swaps` schema actually changes.
- **Fail-closed props.** Props are minted only by Supervisor code. Harmless to add a check, but not a real hole today.
- **Swap log extras, cache headers, SSE retry hints, stricter TS flags.** Nice to have, no behavior risk.

## Actionables

1. [x] Monotonic publication generation; Supervisor ignores non-increasing reads.
2. [x] KV check failures serve current and retry next interval.
3. [x] Hash validation + loader preflight before staging pending.
4. [x] `/__scope` no-op when unchanged.
5. [x] Validate `DRAIN_DEADLINE_MS` / `CHECK_INTERVAL_MS` at stack evaluation.
6. [x] Await `getAlarm()` before demo alarm writes.
7. [x] Pin `@cloudflare/workers-types` to the runtime version and `typescript` exactly.
8. [x] Serialize the source-mutating facet test. Not needed: only facet.test bundles src/app.ts, tests within a file already run serially.
9. [x] README: `router.ts` changes redeploy the Supervisor; stale-KV note.
10. [x] Key `FacetCode` on the hash; keep the bundle code out of Action state.

Implemented actionables 1–3 on this branch. Publication generation is persisted in Alchemy Action output and increases even if the clock stalls or regresses. Supervisors persist the highest accepted generation, preflight before staging, and keep serving current on KV/R2/module failures. Republishing identical code advances ordering without starting another drain. An older content hash can still be deliberately redeployed with a newer generation.

Tests cover stale/invalid publications, transient KV failures, missing R2 code followed by repair, real loader compilation failure, and monotonic generation under a stalled/regressing clock. Publication ordering assumes one serialized deploy writer using the same Alchemy state.
