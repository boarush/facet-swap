---
"facet-swap": minor
---

Versioned notes-over-WebSocket demo implementing RFC 0010: clients negotiate a protocol version once at connect, inbound messages are validated and upgraded at the edge, and pure adapters downgrade events for older clients with translate, skip, or close outcomes.
