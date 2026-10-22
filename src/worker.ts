import type { Env } from "../alchemy.run";

import { createRouter } from "./router";

export { ScopedNotes } from "./notes";
export { Scheduler } from "./scheduler";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker");
    }
  }
}

export { Supervisor } from "./supervisor";

const app = createRouter<Env>();

// These diagnostics historically accept every method.
app.all("/health", () => new Response("ready"));
app.all("/__local/publication", async (c) => {
  const latest = await c.env.VERSIONS.getWithMetadata<{ publication: string; version: string }>(
    "latest",
  );
  const object = latest.value ? await c.env.CODE.head("code/" + latest.value + ".js") : null;
  return Response.json({
    hash: latest.value,
    metadata: latest.metadata,
    uploaded: object?.uploaded.toISOString(),
  });
});
app.all("/u/:user/*", (c) => {
  // Only strip the matched prefix; keep raw user IDs and the forwarded path encoded.
  const user = c.req.path.split("/")[2];
  const url = new URL(c.req.url);
  url.pathname = c.req.path.slice("/u/".length + user.length) || "/";
  return c.env.SUPERVISORS.get(c.env.SUPERVISORS.idFromName(user)).fetch(
    new Request(url, c.req.raw),
  );
});

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
