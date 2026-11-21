import { Schema } from "effect";

import {
  close,
  decodeOrNull,
  skip,
  type ClientMsg,
  type Outcome,
  type ServerEvent,
  type VersionCodec,
} from "../contract";

// Protocol v1, kept for older clients. Compared to the latest contract,
// note.put sent `text`, note.saved had no revision, and note.conflict and
// notes.reset did not exist.

const PutNote = Schema.Struct({
  type: Schema.Literal("note.put"),
  key: Schema.String,
  text: Schema.String,
});
const SwapResumed = Schema.Struct({
  type: Schema.Literal("swap-resumed"),
  hash: Schema.String,
});
const SwapPending = Schema.Struct({
  type: Schema.Literal("swap-pending"),
  hash: Schema.String,
});
const NoteSaved = Schema.Struct({
  type: Schema.Literal("note.saved"),
  key: Schema.String,
});

export const V1 = {
  number: 1,
  ClientMsg: PutNote,
  ServerEvent: Schema.Union([SwapResumed, SwapPending, NoteSaved]),
};
export type V1ClientMsg = Schema.Schema.Type<typeof V1.ClientMsg>;
export type V1ServerEvent = Schema.Schema.Type<typeof V1.ServerEvent>;

// Pure v1 -> latest translation. v1 has only note.put, sent as `text`;
// more v1 message types would turn this into a switch.
export const upgrade = (message: V1ClientMsg): ClientMsg => ({
  type: "note.put",
  key: message.key,
  value: message.text,
});

// `translate` accepts only v1 events, so a new latest event type fails the
// type check in the default case below until a reviewer adds an outcome for
// it. The default policy is Skip; Close needs a justification.
const translate = (event: V1ServerEvent): Outcome<V1ServerEvent> => ({ kind: "send", event });

// Pure latest -> v1 translation, total over the latest contract.
export const downgrade = (event: ServerEvent): Outcome<V1ServerEvent> => {
  switch (event.type) {
    case "note.saved":
      return translate({ type: "note.saved", key: event.key }); // revision dropped
    case "note.conflict":
      return skip; // informational; a v1 client stays correct without it
    case "notes.reset":
      // A v1 client caches notes locally, so silently skipping would leave
      // its cache wrong. It must update before reconnecting.
      return close(4426, "upgrade required");
    default:
      // swap-resumed and swap-pending are unchanged in v1.
      return translate(event);
  }
};

export const v1: VersionCodec = {
  number: V1.number,
  decodeClient: (raw) => {
    const message = decodeOrNull(V1.ClientMsg, raw);
    return message === null ? null : upgrade(message);
  },
  // An adapter bug must not put an invalid shape on the wire, so encoding
  // revalidates and throws instead.
  encodeEvent: (event) => JSON.stringify(Schema.decodeUnknownSync(V1.ServerEvent)(event)),
  downgrade,
};
