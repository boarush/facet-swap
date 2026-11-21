# Development

[Demo](../README.md#run-the-demo) · [Architecture](ARCHITECTURE.md)

Use Node 26 and pnpm 12, pinned per project in `mise.toml` via [mise](https://mise.jdx.dev) (`engines` in `package.json` records the supported range). Tooling configuration lives in the config files.

```sh
pnpm install          # install dependencies
pnpm check            # typecheck
pnpm lint             # lint
pnpm fmt              # format
pnpm fmt:check        # check formatting
pnpm test             # run tests
pnpm test:quick       # skip the stack test while iterating
```

Runtime imports from the stack must be type-only. Runtime and stack code must not import scripts or tests.

Tests cover publication and no-ops, update failures and retries, drains and streams, state preservation, scoped capabilities, alarms, swap history, routing, and the deploy CLI. Integration tests temporarily edit `src/app.ts` and restore it; avoid concurrent source edits or integration runs in the same checkout.

## Local Execution

Start the local stack, with update checks on every request.

```sh
CHECK_INTERVAL_MS=0 pnpm dev
```

In another terminal, edit `src/app.ts` and run `pnpm dev:refresh`. Wait for Alchemy's **Done** message before querying the new version. It requests reconciliation of the running dev stack, not a production deployment. Without dev running, it only records a trigger.

The CLI changes a nonce comment in `facet-version.ts` to trigger evaluation. The nonce does not change the module hash. Unchanged source and salt skip publication.

```sh
pnpm dev:refresh             # preserve the current salt
pnpm dev:refresh my-label     # set a salt
pnpm dev:refresh ''           # clear the salt
```

A different salt changes the hash without a source edit; reusing the same salt does not force publication. Starting dev also evaluates the current source and salt.

`DRAIN_DEADLINE_MS` sets the drain deadline (keep it to tens of seconds; see [Architecture](ARCHITECTURE.md)); `CHECK_INTERVAL_MS` sets the update-check interval. Zero means an immediate deadline or a check on every request, respectively. `PORT` sets the local port.

## Deploy to Cloudflare

```sh
pnpm alchemy profile edit --add Cloudflare
pnpm deploy
```

Outside dev, the publish Actions write R2 and KV through the Cloudflare API with your CLI credentials. Routes, including `/u/<user>/__scope`, are unauthenticated.

Keep both servers on loopback. Routes are unauthenticated; this is not a hardened multi-tenant sandbox. See [Architecture](ARCHITECTURE.md#limits-and-safety) for limits.

## Changesets

Record notable changes with `pnpm changeset`; `pnpm changeset version` applies them to the version and `CHANGELOG.md`.
