import { Schema } from "effect";

// RFC 0010: message schemas live in one module. This latest contract is the
// only shape the application core sees; older versions are translated at the
// edge by pure adapters (./adapters). Within a version, changes are additive
// only: new optional fields and new message types, and clients ignore unknown
// types. Anything else is a new version.

export const LATEST = 2;

export const SwapResumed = Schema.Struct({
  type: Schema.Literal("swap-resumed"),
  hash: Schema.String,
});
export const SwapPending = Schema.Struct({
  type: Schema.Literal("swap-pending"),
  hash: Schema.String,
});
export const NoteSaved = Schema.Struct({
  type: Schema.Literal("note.saved"),
  key: Schema.String,
  revision: Schema.Finite,
});
// Informational: the write was refused, for example by a read-only scope.
export const NoteConflict = Schema.Struct({
  type: Schema.Literal("note.conflict"),
  key: Schema.String,
});
// All notes were wiped; a client that caches notes locally would be wrong
// without hearing about it.
export const NotesReset = Schema.Struct({
  type: Schema.Literal("notes.reset"),
});

export const ServerEvent = Schema.Union([
  SwapResumed,
  SwapPending,
  NoteSaved,
  NoteConflict,
  NotesReset,
]);
export type ServerEvent = Schema.Schema.Type<typeof ServerEvent>;

export const PutNote = Schema.Struct({
  type: Schema.Literal("note.put"),
  key: Schema.String,
  value: Schema.String,
});
// The union of all client messages; note.put is the only member so far.
export const ClientMsg = PutNote;
export type ClientMsg = Schema.Schema.Type<typeof ClientMsg>;

// The total result of downgrading one latest event for an older version.
export type Outcome<E> =
  | { readonly kind: "send"; readonly event: E }
  | { readonly kind: "skip" }
  | { readonly kind: "close"; readonly code: number; readonly reason: string };

// `skip` is the default outcome for a new event type; `close` means an older
// client would be wrong without the event, so it must upgrade before
// reconnecting. `translate` lives in each adapter, typed to that version.
export const skip: Outcome<never> = { kind: "skip" };
export const close = (code: number, reason: string): Outcome<never> => ({
  kind: "close",
  code,
  reason,
});

// Decode a wire value against a schema; null means validation failed.
export const decodeOrNull = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  raw: unknown,
): S["Type"] | null => {
  try {
    return Schema.decodeUnknownSync(schema)(raw);
  } catch {
    return null;
  }
};

// One supported protocol version: how to read a client message into the
// latest contract and how to write a latest event back out.
export type VersionCodec = {
  readonly number: number;
  readonly decodeClient: (raw: unknown) => ClientMsg | null;
  readonly encodeEvent: (event: unknown) => string;
  readonly downgrade: (event: ServerEvent) => Outcome<unknown>;
};

// The latest version is the identity adapter: every event is sent untranslated.
export const latest: VersionCodec = {
  number: LATEST,
  decodeClient: (raw) => decodeOrNull(ClientMsg, raw),
  // Revalidation keeps adapter bugs off the wire.
  encodeEvent: (event) => JSON.stringify(Schema.decodeUnknownSync(ServerEvent)(event)),
  downgrade: (event) => ({ kind: "send", event }),
};
