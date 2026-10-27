# RFC 0010: API Versioning and Contract Boundary

- **Status:** Draft
- **Created:** 2026-10-28

## Summary

Clients negotiate a protocol version once, at connect time. The application core speaks only the latest protocol. Thin adapters at the edge translate older versions up and down, and every message is validated against a schema at that edge.

## Motivation

- Code swaps and protocol changes ship independently of client updates, so old clients stay connected to new code.
- Per-version handlers duplicate business logic and drift apart.
- Without an explicit contract, breaking changes slip in unnoticed.

## Design

### Negotiation

The client requests a version in the handshake (`Sec-WebSocket-Protocol` or a query parameter) and the server echoes the one it accepts. A connection never changes version. Swaps close sockets, so clients renegotiate on reconnect.

### Contract

Message schemas live in one module and are the source of truth. Within a version, changes are additive only: new optional fields and new message types. Clients ignore unknown types. Anything else is a new version.

### Adapters

Each supported old version is a pair of pure functions, `upgrade(msg)` and `downgrade(event)`, chained one version at a time. The core never sees a version number.

### New events and old clients

`downgrade` is total: every latest event maps to exactly one outcome for an older version.

- **Translate.** The event has an older shape. Fields the old version lacks are dropped.
- **Skip.** The event is informational and the old client stays correct without it. It is not sent.
- **Close.** The event changes state the old client depends on, so silently skipping it would leave the client wrong. The server closes the socket with code 4426 (upgrade required) and the client must update before reconnecting.

The default for a new event type is Skip, and a reviewer must decide which events need Close. Events are never sent untranslated, so "clients ignore unknown types" covers forward compatibility within a version, not across versions.

### Example

Built on the notes demo. v2 renames `text` to `value` on `note.put`, adds `revision` to `note.saved`, and adds two events: `note.conflict` (informational) and `notes.reset` (all notes were wiped).

```ts
// contract.ts: latest (v2), the only shapes the core sees
const PutNote = Schema.Struct({
  type: Schema.Literal("note.put"),
  key: Schema.String,
  value: Schema.String,
});
const NoteSaved = Schema.Struct({
  type: Schema.Literal("note.saved"),
  key: Schema.String,
  revision: Schema.Number,
});

// adapters/v1.ts: v1 <-> v2, pure
export const upgrade = (m: V1.ClientMsg): V2.ClientMsg =>
  m.type === "note.put" ? { type: "note.put", key: m.key, value: m.text } : m;

export const downgrade = (e: V2.ServerEvent): Downgraded<V1.ServerEvent> => {
  switch (e.type) {
    case "note.saved":
      return translate({ type: "note.saved", key: e.key }); // revision dropped
    case "note.conflict":
      return skip; // v1 stays correct without it
    case "notes.reset":
      return close(4426); // a v1 client's local cache would be wrong
    default:
      return translate(e);
  }
};
```

A v1 socket negotiates `Sec-WebSocket-Protocol: facet.v1`. Each inbound message is decoded with the v1 schema, upgraded, and handled by the core. Each outbound event is downgraded, then encoded with the v1 schema or skipped, or the socket is closed.

### Support window

A fixed number of versions is supported. Dropping a version deletes its adapters.

## Alternatives

- Version field on every message.
- Separate handlers per version.

## Testing

Adapters are pure, so each one gets table tests over every latest event type. A type check fails when a new event type has no case in an adapter's `downgrade`.

## Unresolved

- Depends on the application built inside facet-swap.
- Support window size and deprecation signalling to clients.
- How HTTP and SSE share the same contract.
