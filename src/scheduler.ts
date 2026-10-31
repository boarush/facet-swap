import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

// Same loopback specialization as Notes, but confined to this Supervisor's alarm.
export class Scheduler extends WorkerEntrypoint<Env, { supervisorId: string; facet: string }> {
  #supervisor() {
    return this.env.SUPERVISORS.get(this.env.SUPERVISORS.idFromString(this.ctx.props.supervisorId));
  }

  setAlarm(time: number | Date): Promise<void> {
    return this.#supervisor().setAlarm(this.ctx.props.facet, time);
  }

  getAlarm(): Promise<number | null> {
    return this.#supervisor().getAlarm(this.ctx.props.facet);
  }

  deleteAlarm(): Promise<void> {
    return this.#supervisor().deleteAlarm(this.ctx.props.facet);
  }
}
