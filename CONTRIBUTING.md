# Contributing

## Branches

Each behavior change goes on its own branch off `master`. When it's done, squash it into one commit, rebase onto `master`, and fast-forward. History stays linear, with no merge commits.

Small docs or tooling fixes can go straight to `master`.

## Changesets

A branch that changes runtime behavior or an API includes one changeset:

```sh
pnpm changeset --patch facet-swap -m "Describe the change"
```

Use `--patch` for fixes and `--minor` for features and breaking changes until 1.0. Docs, tests, and dev tooling need none.

## RFCs

Design proposals live in `rfcs/` as numbered files (`0001-short-name.md`) with a status: Draft, Accepted, Implemented, or Rejected. Larger changes start with an RFC.

## Before Committing

`pnpm test:quick` is enough while iterating. Before committing, run `pnpm check`, `pnpm lint`, `pnpm fmt:check`, and the full `pnpm test`.
