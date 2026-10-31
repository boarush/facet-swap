# RFC 0001: WebSockets and Grace-Window Swaps

- **Status:** Implemented
- **Created:** 2026-10-28

## Summary

Facets accept hibernatable WebSockets directly, and they detect code updates themselves. When a new version is pending, the framework keeps existing transports (WebSocket, SSE, HTTP) open for a grace window, so in-flight work can finish. The application closes the window early by signalling it is idle, or the deadline closes it. Durable recovery of cut work belongs to the application. The Supervisor stops polling for updates. It retains response wrappers only for forced SSE cuts and scope revocation; the application decides when a code swap is safe.

## Motivation

- The Supervisor polls KV every `CHECK_INTERVAL_MS` and holds every response open to count inflight work. Both cost Supervisor wall time.
- WebSockets cannot pass through the Supervisor without pinning it awake, and today an open socket would block a swap until the deadline.
- Only the application knows which work is worth protecting during a swap (mostly LLM calls) and how to resume it.

## Design

### Socket lifetime

Facet abort does not close hibernated sockets in production. Before calling `swap.ready()`, framework code explicitly closes every socket from `ctx.getWebSockets()` with code 1012 and reason `service restart`, ignoring individual close failures. For deadline, scope-change, and restart swaps, the Supervisor calls the facet's `closeSockets()` RPC best-effort, bounded by a one-second timeout per facet, before aborting. Failed or timed-out closes do not block replacement.

### Socket passthrough

The Supervisor forwards upgrade requests to the facet unchanged and returns its `101`. The facet calls `ctx.acceptWebSocket()` and handles `webSocketMessage` and `webSocketClose`. Open sockets stay up through the grace window, then the facet explicitly closes them and clients reconnect to the new code. During the window, new connects get `503` like any request.

### Facet-driven updates

Two unscoped loopback stubs are supplied through the hash-shared loader environment:

- `versions.latest()` reads the KV `latest` pointer (read-only).
- `swap.pending(hash)` and `swap.ready()` notify the Supervisor.

Framework code shipped with the facet checks `latest()` on requests and socket messages, throttled to `CHECK_INTERVAL_MS`. Concurrent checks share a promise. A different hash calls `pending(hash)`; the Supervisor validates publication generation and preflights the module before opening the window. The framework then calls the application's `onUpdate(hash)` hook. Check failures leave current code serving and retry at the next interval. A silent socket triggers no check.

The application owns work tracking and recovery. Its hook calls the framework's `ready()` when idle; completion of protected work may call it later. Open sockets do not count as work and never delay a swap. The demo tracks its requests, streams and alarm handlers, not idle sockets.

### Grace window

During the window, existing sockets, streams, and requests keep running on the old code. The application calls `ready()` once it has nothing in flight, and the Supervisor swaps once any executing alarm deliveries finish. HTTP response bodies do not gate code swaps; scope changes still drain all admitted work. Otherwise, the swap is forced at `DRAIN_DEADLINE_MS`. The deadline runs as an in-memory timer, which keeps the Supervisor awake (and billed for wall time) for the whole window, so keep it short: tens of seconds, not minutes. The framework does not track application work.

### Multiple facets

The Supervisor validates one publication target, but each facet runs the hash recorded in its registry row. The trusted facet passes its plain `{ supervisorId, facet }` identity props to the swap stub; `ready()` replaces only that facet, waiting only for its executing alarm. Admission is closed only for facets still using old code. Facets already on the target are not aborted, and facets instantiated during a window load the target directly.

One deadline starts with the first pending publication and is never extended by new targets or individual readiness. It forces every remaining old facet independently, emitting SSE abort hints only for those facets' streams. An aborted facet has a null `loadedHash` until its next instantiation. Current/pending remain publication-level configurations; current advances when no loaded facet needs replacement. Swap history records the facet name. Scope changes still drain admitted work across all facets before replacing their scoped props.

### Multiple facets

The Supervisor validates one publication target, but each facet runs the hash recorded in its registry row. The trusted facet passes its plain `{ supervisorId, facet }` identity props to the swap stub; `ready()` replaces only that facet, waiting only for its executing alarm. Admission is closed only for facets still using old code. Facets already on the target are not aborted, and facets instantiated during a window load the target directly.

One deadline starts with the first pending publication and is never extended by new targets or individual readiness. It forces every remaining old facet independently, emitting SSE abort hints only for those facets' streams. An aborted facet has a null `loadedHash` until its next instantiation. Current/pending remain publication-level configurations; current advances when no loaded facet needs replacement. Swap history records the facet name. Scope changes still drain admitted work across all facets before replacing their scoped props.

### Client drain handshake

The application may implement a drain handshake. When the window opens, it sends a `swap-pending` control message on every open socket, carrying the target version. Clients finish their current exchange, buffer new sends, and stop starting work. On reconnect after the swap, the server's first message is `swap-resumed` with the new version, and clients flush their buffer. Clients that fall idle this way let the application call `ready()` sooner. Under RFC 0010, `swap-resumed` also carries the negotiated protocol version.

### Supervisor responsibilities

`pending(hash)` validates the hash against KV, because the facet does not choose versions. It also returns `503` for new requests and starts the deadline timer. Forced SSE cuts still emit `update-abort`.

There are no Supervisor-side interval checks in fetch or alarm delivery. Response wrappers remain for best-effort forced SSE cuts and scope drains, not code-swap readiness. No timer runs outside a pending window. Initial activation obtains the current publication once because no facet exists to detect it yet.

### Recovery

Recovery is the application's job. Any work cut by a forced swap or a restart must be resumable from the application's own durable state, for example facet SQLite. Socket clients reconnect on close.

## Alternatives Considered

- **Platform deferred code updates.** Durable Objects keep running old code for up to `max_delay` (default 300s) after a deploy, then reset. An object can abort itself early once it sees a newer version. Either path is a full reset: in-memory state, non-hibernatable sockets, and in-flight work are lost, and every object moves to the new version together. The grace window swaps only the facet, at a moment the application chooses.

- **Deploy-time hash variable in the entry Worker.** No polling, but redeploying the script restarts every Supervisor. Splitting the Supervisor into its own script avoids that, but adds a deploy unit.
- **Supervisor alarm while sockets are open.** One KV read per minute is cheap, but it still wakes the Supervisor and has to share the native alarm with the app scheduler. Facet-driven checks make it unnecessary.
- **Framework-owned work tracking (a lease stub, or a `calls` table with `runCall`).** Lets the framework hold swaps for specific work and rerun it, but couples the framework to application semantics. Recovery needs application knowledge anyway.
- **Supervisor-side check run in parallel with the forward.** Hides the latency, but keeps polling and response tracking in the Supervisor.

## Testing

- Explicit closes deliver code 1012 on readiness and forced swaps. Abort alone does not close hibernated sockets in production (verified), so the framework closes them explicitly.
- Sibling facets see only their own hibernatable sockets in `ctx.getWebSockets()`. Verified once in production (workerd #6702 reports a facet seeing its parent's sockets; the Supervisor never accepts sockets, so that case does not arise).
- The facet detects an update on a message.
- `ready()` during the window swaps immediately.
- Without `ready()`, the swap is forced at the deadline.
- A forged `pending` hash is rejected.
- The demo echoes socket messages with the serving hash; reconnects reach new code.
- Existing transports stay open during the window, and new requests get `503`.

`docs/ARCHITECTURE.md` gains a sockets section, and the swap diagram becomes facet-initiated, once the RFC is implemented.
