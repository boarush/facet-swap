import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

export type NotesScope = { supervisorId: string; readOnly: boolean };

// RPC keeps an error's message but not its class, so denials are tagged by prefix.
export const DENIED = "Notes denied: ";
export const isDenied = (error: unknown) =>
  error instanceof Error && error.message.startsWith(DENIED);

// Scope is asserted by trusted facet code; enforcement stays at the forwarding boundary.
export class ScopedNotes extends WorkerEntrypoint<Env> {
  private key(scope: NotesScope, key: string): string {
    // Treat keys as opaque segments, not paths; no prefix/traversal ambiguity.
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) {
      throw new Error(DENIED + "invalid key");
    }
    return scope.supervisorId + "/" + key;
  }

  get(scope: NotesScope, key: string): Promise<string | null> {
    return this.env.GATEWAY.get(this.key(scope, key));
  }

  put(scope: NotesScope, key: string, value: string): Promise<void> {
    if (scope.readOnly) throw new Error(DENIED + "read-only");
    return this.env.GATEWAY.put(this.key(scope, key), value);
  }

  revision(): Promise<string> {
    return this.env.GATEWAY.revision();
  }
}
