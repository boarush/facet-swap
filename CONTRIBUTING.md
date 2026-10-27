# Contributing

## Branches

Each behavior change goes on its own branch off `master`. When it's done, squash it into one commit, rebase onto `master`, and fast-forward. History stays linear, with no merge commits.

Small docs or tooling fixes can go straight to `master`.

## Changesets

A branch that changes runtime behavior or an API includes one changeset:

```sh
npx changeset --patch facet-swap -m "Describe the change"
```

Use `--patch` for fixes and `--minor` for features and breaking changes until 1.0. Docs, tests, and dev tooling need none.

## RFCs

Design proposals live in `rfcs/` as numbered files (`0001-short-name.md`) with a status: Draft, Accepted, Implemented, or Rejected. Larger changes start with an RFC.

## Before Committing

`npm run test:quick` is enough while iterating. Before committing, run `npm run check`, `npm run lint`, `npm run fmt:check`, and the full `npm test`.
