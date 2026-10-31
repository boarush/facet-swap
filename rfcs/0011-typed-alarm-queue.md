# RFC 0011: Typed Alarm Queue

- **Status:** Implemented
- **Created:** 2026-10-31

## Summary

Facets schedule any number of typed alarms, each with a due time and a JSON payload. The queue lives in the facet's own SQLite. The Supervisor keeps a single native alarm, armed for the earliest due entry, and wakes the facet as it does today.

## Motivation

- A Durable Object has one native alarm, so the facet can hold only one scheduled wake-up.
- Applications need several independent timers (reminders, retries, cleanups), each with its own data.
- The application already owns its durable state. Its timers belong there too and survive code swaps with it.

## Design

### API

A small module in the facet wraps storage and the existing `scheduler` props stub:

```ts
const alarms = new Alarms(ctx, {
  reminder: async (payload) => { ... },
  cleanup: async (payload) => { ... },
});

const id = alarms.schedule("reminder", time, { text: "standup" });
alarms.cancel(id);
alarms.list("reminder");
```

Handler types define the allowed alarm types and their payload shapes.

### Storage

One table in facet SQLite: `alarms(id, type, time, payload, attempts)`, indexed on `time`. Entries with the same time run in insertion order.

### Arming

After every `schedule` or `cancel`, the facet sets the Supervisor's alarm to the earliest `time` in the table, or deletes it when the table is empty. The Supervisor's alarm logic stays unchanged, including deferral during drains.

### Delivery

On wake, the facet runs each due entry through the handler for its type, in time order. A successful entry is deleted. A failing entry increments `attempts` and moves to `now + backoff` (1s doubling, capped at 1h), and the rest still run. After 10 attempts the entry is dropped and logged. An entry whose type has no handler counts as a failure, so code that adds the handler within the retry window still delivers it. Handlers may schedule new alarms, including their own type. Entries a handler schedules for the past wait for the next wake. After the loop, and whenever the facet starts, it rearms for the next entry.

Delivery is at least once. A swap or restart mid-handler reruns the entry, so handlers must be idempotent.

## Alternatives Considered

- **Queue in the Supervisor.** Keeps the facet simple, but puts application data and payloads in framework storage, and the framework would have to know about types.
- **One native alarm per type.** A Durable Object has only one native alarm.

## Testing

- Multiple alarms of the same and different types fire in time order.
- `cancel` removes an entry and rearms for the next one.
- A failing handler retries with backoff without blocking other entries.
- A handler that schedules a new alarm gets it delivered.
- Entries survive a code swap and fire on the new version.
