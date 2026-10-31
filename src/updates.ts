import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

import type { AlarmScope } from "./scheduler";
import type { Publication } from "./version-source";

export class Versions extends WorkerEntrypoint<Env> {
  latest(): Promise<Publication | null> {
    return this.env.VERSIONS.get<Publication>("latest", "json");
  }
}

export class Swap extends WorkerEntrypoint<Env> {
  #supervisor(scope: AlarmScope) {
    return this.env.SUPERVISORS.get(this.env.SUPERVISORS.idFromString(scope.supervisorId));
  }

  pending(scope: AlarmScope, hash: string): Promise<boolean> {
    return this.#supervisor(scope).pending(hash);
  }

  ready(scope: AlarmScope): Promise<void> {
    return this.#supervisor(scope).ready(scope.facet);
  }
}

export type UpdateEnv = {
  VERSIONS: Service<Versions>;
  SWAP: Service<Swap>;
};

export class FacetUpdates {
  private lastCheck = -Infinity;
  private checking?: Promise<void>;
  private pendingHash?: string;

  constructor(
    private readonly env: UpdateEnv,
    private readonly scope: AlarmScope,
    private readonly hash: string,
    private readonly interval: number,
    private readonly onUpdate: (hash: string) => void | Promise<void>,
    private readonly ctx: Pick<DurableObjectState, "getWebSockets">,
  ) {}

  check(): Promise<void> {
    if (this.checking) return this.checking;
    if (Date.now() - this.lastCheck < this.interval) return Promise.resolve();
    this.lastCheck = Date.now();
    this.checking = (async () => {
      try {
        const latest = await this.env.VERSIONS.latest();
        if (!latest || latest.hash === this.hash || latest.hash === this.pendingHash) return;
        if (await this.env.SWAP.pending(this.scope, latest.hash)) {
          this.pendingHash = latest.hash;
          await this.onUpdate(latest.hash);
        }
      } catch (error) {
        console.error("Facet update check failed; keeping current code", error);
      }
    })().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  closeSockets(): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1012, "service restart");
      } catch {
        // A disconnected socket must not prevent replacement.
      }
    }
  }

  ready(): Promise<void> {
    this.closeSockets();
    return this.env.SWAP.ready(this.scope);
  }
}
