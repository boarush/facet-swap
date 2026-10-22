import { WorkerEntrypoint } from "cloudflare:workers";

import type { GatewayEnv } from "../alchemy.run";

// Only trusted service callers get this unscoped API. No public data route.
export class Notes extends WorkerEntrypoint<GatewayEnv> {
  async get(key: string): Promise<string | null> {
    return (await this.env.NOTES.get(key))?.text() ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    await this.env.NOTES.put(key, value);
  }

  revision(): string {
    return this.env.REVISION;
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
