import type { Supervisor } from "./supervisor";

export interface Env {
  CODE: R2Bucket;
  VERSIONS: KVNamespace;
  LOADER: WorkerLoader;
  SUPERVISORS: DurableObjectNamespace<Supervisor>;
  CHECK_INTERVAL_MS: string;
}
