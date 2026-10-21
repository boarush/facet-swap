This is a local-only, self-updating Durable Object facet prototype, driven by Alchemy v2. No Cloudflare account, credentials, remote state store, or production deploy is used. The stack refuses to evaluate outside Alchemy dev mode.

The entry Worker routes /u/<user>/stream and /u/<user>/version into one Supervisor per user. Each Supervisor owns a stable SQLite database containing current and pending hashes. It lazily reads KV latest on requests, at most once every CHECK_INTERVAL_MS (10000 by default). The facet named app gets its own SQLite database. Its served counter increments once per stream, not once per event.

A pending update closes admission to that user's facet. Existing response bodies finish before the last inflight slot is released. A TransformStream pipe tracks EOF, errors, and client cancellation, not just response headers. At zero inflight, the Supervisor synchronously persists current=pending and clears pending, aborts app without deleting its storage, then resumes queued requests. The next facet get loads the new class from the hash-keyed Worker Loader. There are no alarms, force swaps, drain deadlines, rollback, or canary paths. An indefinitely open stream deliberately blocks that user's update indefinitely.

Install with Node, npm, and Bun available.

```sh
cd ~/facet-swap
npm ci
npm run check
npm test
```

Vitest runs the integration test through Alchemy's native `alchemy/Test/Vitest` adapter in dev mode, with its real local-provider sidecar, a random loopback port, and an isolated stage. It deploys the same stack declaration with v1, repeats v1, opens an SSE stream, then deploys v2 mid-stream. The repeated v1 deployment must leave both the actual R2 upload timestamp and KV publication metadata unchanged. It checks a queued request via local diagnostics, proves another user's independent update, checks all 25 old stream events remain v1, checks the queued response and a fresh stream use v2, and verifies the SQLite counter survives. It also publishes v3 and verifies client cancellation releases the gate. The adapter owns the local dev server and closes its shared scope and sidecar in its Vitest afterAll hook; its provider finalizer destroys the scratch stack even on failure. No separate server launcher or globalSetup is necessary. Run `npm test > test-dev.log 2>&1` to capture startup diagnostics. Its test watchdog is not a Supervisor drain timeout.

For a manual demo, run this in one terminal. A zero check interval makes the next request detect publication immediately.

```sh
CHECK_INTERVAL_MS=0 npm run dev
```

In another terminal, request v1. Once Alchemy reports Done, start a stream.

```sh
npm run deploy -- v1
curl -N 'http://127.0.0.1:18743/u/alice/stream?n=20&ms=500'
```

While that stream is running, use a third terminal to publish v2 and request the version. Wait for Alchemy to report Done before the curl commands. The version request then waits until Alice's existing stream ends and answers v2. Bob's version request would not wait on Alice.

```sh
npm run deploy -- v2
curl 'http://127.0.0.1:18743/u/alice/version'
curl 'http://127.0.0.1:18743/u/alice/stream?n=3&ms=100'
```

PORT overrides the manual server port. `npm run deploy -- v2` edits the imported `facet-version.ts` stack input and requests reconciliation. It no longer bundles, uploads, or calls HTTP endpoints itself. It changes a comment as well, so even the same label triggers a fresh plan for source-only edits; that comment is not part of the facet bundle or Action inputs. Keep the Alchemy dev terminal running and wait for its Done message before querying the new version. A request is not a confirmation that deployment succeeded. Version changes do not alter the supervisor Worker's bundle, so its local provider stays noop and active streams survive the stack reload.

`alchemy.run.ts` calls `bundleFacet` and `publishFacet` from `infra/facet.ts`. `alchemy/Bundle.build` uses Alchemy's existing rolldown abstraction to build a single ESM module from `src/app.ts` with the version embedded. Its file-level SHA-256 addresses `code/<hash>.js`; the aggregate bundle hash is deliberately not used. The hash goes to the dynamic worker as env.HASH rather than being embedded in its own bundle, avoiding a self-referential content hash.

Publication is two built-in `Alchemy.Action` graph nodes. FacetCode writes the module through `Cloudflare.R2.WriteBucketLocal`; FacetLatest takes the successful upload's hash output and writes KV through `Cloudflare.KV.WriteNamespaceLocal`. That output edge prevents publishing a pointer before its object exists. Both clients recognize locally emulated resource IDs and use Alchemy's scoped platform-proxy gateways into the same `.alchemy/local` storage as the Worker. No Cloudflare credentials or custom gateway are needed.

The installed beta.83 has no R2 object or KV value lifecycle resources, so these small Action bodies fill that gap without a custom Resource or Provider. Alchemy persists and diffs their resolved inputs. A stack evaluation still bundles the source to discover changes, but identical module bytes skip the R2 upload and identical hash/version inputs skip the KV write. Actions do not read for drift or delete artifacts; old code objects remain available for supervisors that have not updated. If emulator data is removed independently of state, a forced reconciliation is needed. `--force` intentionally reruns Actions.

This is stack-driven publishing, not a separate facet source watcher. Changing `facet-version.ts` triggers reconciliation. After editing only facet source, run `npm run deploy -- <label>` to trigger another evaluation, or restart dev. Repeating the same label leaves the artifact hash unchanged unless the emitted code changed.


Alchemy beta.83 already has a native WorkerLoader() binding and native local Worker Loader support. Its API calls the DO namespace declaration DurableObject(), rather than DurableObjectNamespace(). No raw binding passthrough, plain Wrangler fallback, or custom workerd launcher was needed.

The one runtime workaround is an npm override. Alchemy beta.83's cloudflare-runtime pins workerd 1.20261002.1. This project pins and overrides it to 1.20261021.1 for current facets support, without modifying node_modules. The checked-in lockfile captures that exact tested runtime. npm did not have a beta dist-tag when checked; latest was 2.0.0-beta.83, while next pointed at older beta.72. The project pins beta.83 explicitly.

The old PUT /__local/code and PUT /__local/latest endpoints are removed. GET /__local/publication is read-only diagnostics for the latest hash, KV publication metadata, and R2 upload timestamp. GET /u/<user>/__status bypasses admission so the test can observe a drain. These diagnostic routes are local-only conveniences, not production authentication boundaries.

Keep the dev server on loopback. Do not expose or tunnel it. Only trusted local stack code should publish facets; this intentionally executes the bundled code. Dynamic code receives no R2, KV, or namespace binding and has globalOutbound=null, but this is a prototype, not a hardened multi-tenant service. The in-memory queue and inflight tracking are not durable across Supervisor crashes. Pending/current and facet SQLite data are persistent, not active connections. Errors propagate rather than falling back to old code. Local KV does not model production KV propagation delay.

npm audit reports advisories in Alchemy's transitive dependencies, including Prisma's Hono-related tree and lodash; these were not force-upgraded or claimed fixed. No Prisma service or Hono application is part of this prototype. Review dependencies before adapting this for production.

Reference documentation is at https://alchemy.run/environments/local-development and https://alchemy.run/cloudflare/compute/worker-loader and https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/ . The installed Alchemy sources for Workers/WorkerLoader.ts, Workers/RuntimeBindings.ts, Workers/DurableObject.ts, R2/Bucket.ts, KV/Namespace.ts, and State/LocalState.ts were also checked.


The publication implementation was checked against the installed `alchemy/src/Bundle/Bundle.ts`, `Action.ts`, `Cloudflare/R2/WriteBucketLocal.ts`, `Cloudflare/R2/LocalR2Gateway.ts`, `Cloudflare/KV/WriteNamespaceLocal.ts`, and `Cloudflare/KV/LocalKVGateway.ts`. The custom-provider lifecycle and local-provider routes were also checked before choosing the simpler Actions abstraction. References are https://alchemy.run/infrastructure-as-code/action/ , https://alchemy.run/infrastructure-as-code/custom-provider/ , https://alchemy.run/infrastructure-as-code/local-provider/ , and https://github.com/alchemy-run/alchemy/blob/main/packages/alchemy/src/Bundle/Bundle.ts .

The layout keeps runtime and deployment separate. `src/` contains only Worker and facet runtime code; its stack dependency is type-only for inferred bindings. `infra/` contains bundling and publication Effects used by `alchemy.run.ts`. `scripts/` contains CLI entrypoints only and is never imported by runtime or stack code. `test/` contains integration tests. `facet-version.ts` is the manual stack input.
