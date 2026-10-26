import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

export type NotesScope = { user: string; readOnly: boolean };

// RPC keeps an error's message but not its class, so denials are tagged by prefix.
export const DENIED = "Notes denied: ";
export const isDenied = (error: unknown) =>
  error instanceof Error && error.message.startsWith(DENIED);

// Cross-worker service bindings cannot receive caller-selected runtime props.
// A specialized loopback binding can, and remains serializable in loader env.
// Keep enforcement here; never give the facet GATEWAY or a factory for new scopes.
export class ScopedNotes extends WorkerEntrypoint<Env, NotesScope> {
  private key(key: string): string {
    // Treat keys as opaque segments, not paths; no prefix/traversal ambiguity.
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) {
      throw new Error(DENIED + "invalid key");
    }
    return this.ctx.props.user + "/" + key;
  }

  get(key: string): Promise<string | null> {
    return this.env.GATEWAY.get(this.key(key));
  }

  put(key: string, value: string): Promise<void> {
    if (this.ctx.props.readOnly) throw new Error(DENIED + "read-only");
    return this.env.GATEWAY.put(this.key(key), value);
  }

  revision(): Promise<string> {
    return this.env.GATEWAY.revision();
  }
}
