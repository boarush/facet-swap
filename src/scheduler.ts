import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

export type AlarmScope = { supervisorId: string; facet: string };
export class Scheduler extends WorkerEntrypoint<Env> {
  #supervisor(scope: AlarmScope) {
    return this.env.SUPERVISORS.get(this.env.SUPERVISORS.idFromString(scope.supervisorId));
  }

  setAlarm(scope: AlarmScope, time: number | Date): Promise<void> {
    return this.#supervisor(scope).setAlarm(scope.facet, time);
  }

  getAlarm(scope: AlarmScope): Promise<number | null> {
    return this.#supervisor(scope).getAlarm(scope.facet);
  }

  deleteAlarm(scope: AlarmScope): Promise<void> {
    return this.#supervisor(scope).deleteAlarm(scope.facet);
  }
}
