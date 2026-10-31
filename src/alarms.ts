import type { AlarmScope, Scheduler } from "./scheduler";

type Handler = (payload: never) => Promise<void>;
type Row = { id: number; type: string; time: number; payload: string; attempts: number };
type Context = Pick<DurableObjectState<AlarmScope>, "storage" | "props">;

export class Alarms<H extends Record<string, Handler>> {
  constructor(
    private readonly ctx: Context,
    private readonly scheduler: Service<Scheduler>,
    private readonly handlers: H,
  ) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS alarms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, time INTEGER NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS alarms_time ON alarms(time);
    `);
    // Heals a rearm that failed after its row was written.
    this.rearm().catch((error) => console.error("Alarm rearm failed", error));
  }

  async schedule<K extends keyof H & string>(
    type: K,
    time: number,
    payload: Parameters<H[K]>[0],
  ): Promise<number> {
    if (!Number.isSafeInteger(time) || time <= 0) throw new Error("Invalid alarm time");
    const json = JSON.stringify(payload);
    if (json === undefined) throw new Error("Alarm payload must be JSON");
    const { id } = this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO alarms (type, time, payload, attempts) VALUES (?, ?, ?, 0) RETURNING id",
        type,
        time,
        json,
      )
      .one();
    await this.rearm();
    return id;
  }

  async cancel(id: number): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM alarms WHERE id = ?", id);
    await this.rearm();
  }

  list<K extends keyof H & string>(type?: K) {
    const rows =
      type === undefined
        ? this.ctx.storage.sql.exec<Row>("SELECT * FROM alarms ORDER BY time, id")
        : this.ctx.storage.sql.exec<Row>(
            "SELECT * FROM alarms WHERE type = ? ORDER BY time, id",
            type,
          );
    return rows.toArray().map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
  }

  async run(): Promise<void> {
    // Snapshot due work so a self-scheduling handler cannot monopolize this delivery.
    const due = this.ctx.storage.sql
      .exec<Row>("SELECT * FROM alarms WHERE time <= ? ORDER BY time, id", Date.now())
      .toArray();
    for (const row of due) {
      // Earlier handlers may cancel another due entry.
      if (!this.ctx.storage.sql.exec("SELECT id FROM alarms WHERE id = ?", row.id).toArray().length)
        continue;
      try {
        const handler = Object.hasOwn(this.handlers, row.type)
          ? this.handlers[row.type]
          : undefined;
        if (!handler) throw new Error("Unknown alarm type: " + row.type);
        await handler(JSON.parse(row.payload) as never);
      } catch (error) {
        const attempts = row.attempts + 1;
        if (attempts >= 10) {
          console.error("Dropping alarm after 10 attempts", row.id, row.type, error);
          this.ctx.storage.sql.exec("DELETE FROM alarms WHERE id = ?", row.id);
        } else {
          this.ctx.storage.sql.exec(
            "UPDATE alarms SET attempts = ?, time = ? WHERE id = ?",
            attempts,
            Date.now() + Math.min(1000 * 2 ** row.attempts, 3600000),
            row.id,
          );
        }
        continue;
      }
      this.ctx.storage.sql.exec("DELETE FROM alarms WHERE id = ?", row.id);
    }
    await this.rearm();
  }

  private async rearm(): Promise<void> {
    const { time } = this.ctx.storage.sql
      .exec<{ time: number | null }>("SELECT MIN(time) AS time FROM alarms")
      .one();
    if (time === null) await this.scheduler.deleteAlarm(this.ctx.props);
    else await this.scheduler.setAlarm(this.ctx.props, time);
  }
}
