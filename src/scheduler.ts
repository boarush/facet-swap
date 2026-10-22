import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../alchemy.run";

// Same loopback specialization as Notes, but confined to this Supervisor's alarm.
export class Scheduler extends WorkerEntrypoint<Env, { user: string }> {
  private supervisor() {
    return this.env.SUPERVISORS.get(this.env.SUPERVISORS.idFromString(this.ctx.props.user));
  }

  setAlarm(time: number | Date): Promise<void> {
    return this.supervisor().setAlarm(time);
  }

  getAlarm(): Promise<number | null> {
    return this.supervisor().getAlarm();
  }

  deleteAlarm(): Promise<void> {
    return this.supervisor().deleteAlarm();
  }
}
