import type { InferEnv } from "alchemy/Cloudflare";
import type { worker } from "../alchemy.run";

// Map the stack's bindings to their native Workers runtime types.
export type Env = InferEnv<typeof worker>;
