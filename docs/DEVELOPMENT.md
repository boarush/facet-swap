# Development

[Demo](../README.md#run-the-demo) · [Architecture](ARCHITECTURE.md)

Use Node + npm (see `engines` in `package.json`). Tooling configuration lives in the config files.

```sh
npm ci                # install dependencies
npm run check         # typecheck
npm run lint          # lint
npm run fmt           # format
npm run fmt:check     # check formatting
npm test              # run tests
```

Runtime imports from the stack must be type-only. Runtime and stack code must not import scripts or tests.

Tests cover publication and no-ops, update failures and retries, drains and streams, state preservation, scoped capabilities, alarms, swap history, routing, and the deploy CLI. Integration tests temporarily edit `src/app.ts` and restore it; avoid concurrent source edits or integration runs in the same checkout.

## Local Execution

Start the local stack, with update checks on every request.

```sh
CHECK_INTERVAL_MS=0 npm run dev
```

In another terminal, edit `src/app.ts` and run `npm run dev:refresh`. Wait for Alchemy's **Done** message before querying the new version. It requests reconciliation of the running dev stack, not a production deployment. Without dev running, it only records a trigger.

The CLI changes a nonce comment in `facet-version.ts` to trigger evaluation. The nonce does not change the module hash. Unchanged source and salt skip publication.

```sh
npm run dev:refresh             # preserve the current salt
npm run dev:refresh -- my-label # set a salt
npm run dev:refresh -- ''       # clear the salt
```

A different salt changes the hash without a source edit; reusing the same salt does not force publication. Starting dev also evaluates the current source and salt.

`DRAIN_DEADLINE_MS` sets the drain deadline; `CHECK_INTERVAL_MS` sets the update-check interval. Zero means an immediate deadline or a check on every request, respectively. `PORT` sets the local port.

## Deploy to Cloudflare

```sh
npx alchemy profile edit --add Cloudflare
npm run deploy
```

Outside dev, the publish Actions write R2 and KV through the Cloudflare API with your CLI credentials. Routes, including `/u/<user>/__scope`, are unauthenticated.

Keep both servers on loopback. Routes are unauthenticated; this is not a hardened multi-tenant sandbox. See [Architecture](ARCHITECTURE.md#limits-and-safety) for limits.

## Changesets

Record notable changes with `npx changeset`; `npx changeset version` applies them to the version and `CHANGELOG.md`.
