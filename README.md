# Self-Updating Services on Durable Object Facets

A local prototype of self-updating per-user services on Cloudflare Durable Object facets. A stable Supervisor replaces a versioned, content-hashed application facet after draining its work, or cutting it at a deadline. Alchemy bundles and publishes the code; facet SQLite state survives replacement.

Each user gets a Supervisor with a named `app` facet. Requests and application alarms lazily check KV for a newer publication. The Supervisor validates and warms the new module, stops admitting requests while old work drains, then commits the new configuration and recreates the facet. Clients retry admission 503s and interrupted streams.

The [architecture guide](docs/ARCHITECTURE.md) covers capabilities, publication, swaps, streams, alarms, and safety limits. The [development guide](docs/DEVELOPMENT.md) covers tooling, tests, and local deployment.

## Layout

`src/` holds the entry Worker, Supervisor, gateway, scoped services, loader, and demo facet.
`src/router.ts` is shared by the facet and stable Workers; editing it redeploys the entry Worker and Supervisor too.
`alchemy.run.ts` declares resources, bundling, and publication.
`facet-version.ts` holds an optional label salt and the deploy reconciliation nonce.
`scripts/deploy.ts` triggers stack evaluation; `test/` holds integration and regression tests.
`docs/ARCHITECTURE.md` describes runtime and deployment boundaries; `docs/DEVELOPMENT.md` covers development.
`rfcs/` tracks design proposals and their status.

Install dependencies using the [development guide](docs/DEVELOPMENT.md). The local stack needs no Cloudflare credentials.

## Run the Demo

Start dev with checks on every request.

```sh
CHECK_INTERVAL_MS=0 npm run dev
```

In another terminal, reconcile the current source, wait for Alchemy's Done message, and open a stream.

```sh
npm run dev:refresh
curl -N 'http://127.0.0.1:18743/u/alice/stream?n=20&ms=500'
```

While it runs, edit `src/app.ts` and run `npm run dev:refresh` again. See [Development](docs/DEVELOPMENT.md#local-execution) for label-only updates and deploy behavior.

After Done, request `/u/alice/version`. During the drain it returns 503 with retry and current/pending hash headers. Wait at least one second plus jitter and retry. Once the stream finishes or the deadline cuts it, the response shows the new hash and the preserved served counter. A cut SSE stream ends with a best-effort `update-abort` event. Bob's requests are unaffected by Alice's drain.

Set `DRAIN_DEADLINE_MS` when starting dev to change the default 30-second deadline. The normal check interval is 10 seconds.

Keep both servers on loopback. Routes are unauthenticated, and this is not a hardened multi-tenant sandbox or a production rollout system.
