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

The test starts its own Alchemy dev process on a random loopback port and isolated stage, publishes v1, opens an SSE stream, then publishes v2 mid-stream. It checks a queued request via local diagnostics, proves another user's independent update, checks all 25 old stream events remain v1, checks the queued response and a fresh stream use v2, and verifies the SQLite counter survives. It also publishes v3 and verifies client cancellation releases the gate. The test kills its own dev process afterward. test-dev.log contains startup diagnostics. Its test watchdog is not a Supervisor drain timeout.

For a manual demo, run this in one terminal. A zero check interval makes the next request detect publication immediately.

```sh
CHECK_INTERVAL_MS=0 npm run dev
```

In another terminal, publish v1 and start a stream.

```sh
npm run deploy -- v1
curl -N 'http://127.0.0.1:18743/u/alice/stream?n=20&ms=500'
```

While that stream is running, use a third terminal to publish v2 and request the version. That request waits until Alice's existing stream ends, then answers v2. Bob's version request would not wait on Alice.

```sh
npm run deploy -- v2
curl 'http://127.0.0.1:18743/u/alice/version'
curl 'http://127.0.0.1:18743/u/alice/stream?n=3&ms=100'
```

PORT overrides the manual server port. BASE_URL overrides the deploy client's destination, restricted to loopback HTTP. The deploy script bundles src/app.ts with an embedded version label, computes its SHA-256, uploads it to local R2 at code/<hash>.js, then publishes that hash to local KV latest. The hash is passed to the dynamic worker as env.HASH rather than embedded in its own bundle, avoiding a self-referential content hash.

alchemy.run.ts declares the Worker, R2 bucket, KV namespace, WorkerLoader binding, and Supervisor DurableObject binding. src/worker.ts contains the stable router and Supervisor. src/app.ts is the replaceable facet. scripts/deploy.mjs is the local publication client. scripts/test.mjs is the end-to-end test. Alchemy's state and emulator files live in ignored .alchemy/.

Alchemy beta.83 already has a native WorkerLoader() binding and native local Worker Loader support. Its API calls the DO namespace declaration DurableObject(), rather than DurableObjectNamespace(). No raw binding passthrough, plain Wrangler fallback, or custom workerd launcher was needed.

The one runtime workaround is an npm override. Alchemy beta.83's cloudflare-runtime pins workerd 1.20261002.1. This project pins and overrides it to 1.20261021.1 for current facets support, without modifying node_modules. The checked-in lockfile captures that exact tested runtime. npm did not have a beta dist-tag when checked; latest was 2.0.0-beta.83, while next pointed at older beta.72. The project pins beta.83 explicitly.

The local publication API is a small workaround for updating Alchemy's already-running R2 and KV emulators without using Wrangler's separate storage directory. PUT /__local/code writes through the real local R2 binding and verifies the content hash. PUT /__local/latest checks that the R2 object exists before writing KV. GET /u/<user>/__status is a local-only diagnostic route that bypasses admission so the test can observe a drain. None of these routes are production-safe authentication boundaries.

Keep the dev server on loopback. Do not expose or tunnel it. Anyone able to reach the publication endpoints can execute arbitrary facet code. Dynamic code receives no R2, KV, or namespace binding and has globalOutbound=null, but this is a prototype, not a hardened multi-tenant service. The in-memory queue and inflight tracking are not durable across Supervisor crashes. Pending/current and facet SQLite data are persistent, not active connections. Errors propagate rather than falling back to old code. Local KV does not model production KV propagation delay.

npm audit reports advisories in Alchemy's transitive dependencies, including Prisma's Hono-related tree and lodash; these were not force-upgraded or claimed fixed. No Prisma service or Hono application is part of this prototype. Review dependencies before adapting this for production.

Reference documentation is at https://alchemy.run/environments/local-development and https://alchemy.run/cloudflare/compute/worker-loader and https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/ . The installed Alchemy sources for Workers/WorkerLoader.ts, Workers/RuntimeBindings.ts, Workers/DurableObject.ts, R2/Bucket.ts, KV/Namespace.ts, and State/LocalState.ts were also checked.
