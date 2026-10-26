# Development

[Setup and demo](../README.md) · [Architecture](ARCHITECTURE.md)

## Tooling

Use Node 24.11.1+ within the 24.x line, or Node 25.1+, and npm. The dev command runs Alchemy under Node with its Oxc loader for the TypeScript stack. The deploy CLI uses Node's native type stripping and erasable TypeScript syntax.

```sh
npm ci
npm run check
npm run lint
npm run fmt:check
npm test
```

### Types and lint

`npm run check` runs TypeScript 7.0.2's native compiler through `tsc --noEmit`. Runtime, stack, scripts, and tests share the strict typecheck. `verbatimModuleSyntax` requires explicit type-only imports.

The prepare hook runs `effect-tsgo patch --typescript --oxlint`. TypeScript, Oxlint, and `oxlint-tsgolint` are pinned to versions supported by `@effect/tsgo`; check its compatibility table when upgrading them together. Effect diagnostics run through Oxlint. The TypeScript plugin options set `diagnostics: false` to avoid duplicate diagnostics. Editors use the Effect native language server.

Binding types are inferred from the stack as `Env = InferEnv<typeof worker>` and `GatewayEnv = InferEnv<ReturnType<typeof gatewayWorker>>`. Runtime modules import these types without including stack code in Worker bundles.

Oxlint applies type-aware correctness rules, the Effect recommended preset, Promise checks, type-only imports, import-cycle checks, and Vitest assertion/title checks. Focused or disabled tests are errors, and warnings fail `npm run lint`.

Import boundaries keep runtime and infrastructure separate from CLI entrypoints and tests. Runtime imports from `alchemy.run.ts` must be type-only.

### Formatting

`npm run fmt` writes Oxfmt formatting; `npm run fmt:check` checks it. Oxfmt also sorts imports and package keys.

Imports are grouped as Node builtins, external packages, project-boundary imports, then relative modules, with blank lines between groups. Type imports stay with their group, and side-effect imports retain evaluation order.

### Runtime versions

Alchemy and `@alchemy.run/cloudflare` are pinned to beta.84. The provider supplies workerd 1.20261012.1. `@cloudflare/workers-types` is pinned to 5.20261012.1 to match that runtime date; update the types pin when upgrading Alchemy's runtime.

The stack Workers and loaded facets use compatibility date 2026-10-12. Cloudflare resources and inferred binding types come from the provider package; bundling, Actions, state, and the Vitest adapter come from core Alchemy.

## Tests

`npm test` runs Vitest. The integration suite uses `alchemy/Test/Vitest`, a real local-provider sidecar, an isolated stage, and a random loopback port. The adapter owns server cleanup and stack destruction. Integration tests use a three-second drain deadline and a watchdog for the full run.

Publication coverage includes source-only and label-only changes, unchanged-deploy no-ops, hash-addressed Action state, upload/publication metadata, and increasing generations with a frozen or regressing clock. Update-safety cases cover stale or malformed publications, transient KV failures, missing R2 code, loader compilation failures, and successful retries after repair.

Swap coverage includes admission 503s and retry headers, complete old streams during normal drains, deadline abort events, cancellation, preserved facet state, and independent users. Capability cases exercise real RPC serialization, note-key confinement, read-only scope changes, unchanged-scope no-ops, and the local gateway channel limitation described in [Architecture](ARCHITECTURE.md#gateway-deployment-boundary).

Alarm tests cover scheduling, cancellation, rearming, native retries, alarm-driven updates, drain deferrals, and interrupted handlers. Supervisor tests reuse in-memory SQLite to check restart state, atomic swap history, retention, query validation, and aborted-body counts. These reconstruction tests model storage reuse, not a process crash.

Routing and response-wrapper tests cover encoded paths, raw user IDs, forwarded requests, method errors, validation, propagated errors, HEAD cancellation, EOF, and non-SSE aborts. The isolated CLI test checks salt preservation, argument escaping, nonce changes, and empty-label handling.

The integration suite temporarily edits `src/app.ts` and restores it in a `finally` block. Avoid concurrent source edits or another integration run in the same checkout.

## Local Execution

Start the local stack in one terminal.

```sh
CHECK_INTERVAL_MS=0 npm run dev
```

In another terminal, edit the application source and request reconciliation.

```sh
npm run deploy
```

Wait for Alchemy's **Done** message before querying the new version. The CLI only changes `facet-version.ts`; the running dev process bundles and publishes. Without a dev process, the CLI records a trigger but performs no deployment. The checked-in stack rejects non-dev execution.

Alchemy watches the stack import graph, while the facet source is bundled separately during evaluation. The CLI changes a reconciliation nonce comment to trigger that evaluation. The nonce is not compiled into the facet or included in Action inputs, so unchanged source and salt leave R2 and KV publication unchanged.

With no argument, the CLI preserves the existing salt and other comments. An explicit argument writes the salt and a fresh nonce.

```sh
npm run deploy -- my-label
npm run deploy -- ''
```

The default salt is `"v1"`. A different salt changes the module hash without a source edit; an empty argument clears it. Reusing the same salt does not force publication. Starting dev evaluates the current source and salt as well.

`CHECK_INTERVAL_MS` defaults to 10,000 milliseconds and `DRAIN_DEADLINE_MS` to 30,000. Stack evaluation validates both as whole milliseconds from zero through 2,147,483,647. Zero allows an update check on every request or an immediate drain deadline, respectively. `PORT` defaults to 18743.

Keep both servers on loopback. Routes are unauthenticated. See the [README demo](../README.md#run-the-demo) for a stream/update walkthrough and [Architecture](ARCHITECTURE.md#limits-and-safety) for runtime limits.
