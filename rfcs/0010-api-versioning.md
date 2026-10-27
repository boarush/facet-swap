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

### Support window

A fixed number of versions is supported. Dropping a version deletes its adapters.

## Alternatives

- Version field on every message.
- Separate handlers per version.

## Testing

TBD.

## Unresolved

- Depends on the application built inside facet-swap.
- Support window size and deprecation signalling to clients.
- How HTTP and SSE share the same contract.
