import type { Env } from "../alchemy.run";

import { createRouter } from "./router";
import type { Publication } from "./version-source";

export { ScopedNotes } from "./notes";
export { Scheduler } from "./scheduler";
export { Supervisor } from "./supervisor";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker");
    }
  }
}

const app = createRouter<Env>();

app.get("/health", () => new Response("ready"));
app.get("/__local/publication", async (c) => {
  const latest = await c.env.VERSIONS.getWithMetadata<
    Publication,
    { publication: string; version: string }
  >("latest", "json");
  const object = latest.value ? await c.env.CODE.head("code/" + latest.value.hash + ".js") : null;
  return Response.json({
    hash: latest.value?.hash ?? null,
    generation: latest.value?.generation ?? null,
    metadata: latest.metadata,
    uploaded: object?.uploaded.toISOString(),
  });
});
for (const path of ["/health", "/__local/publication"]) {
  app.all(path, () => new Response("Method not allowed", { status: 405 }));
}
app.all("/u/:user/*", (c) => {
  // Only strip the matched prefix; keep raw user IDs and the forwarded path encoded.
  const user = c.req.path.split("/")[2];
  const url = new URL(c.req.url);
  url.pathname = c.req.path.slice("/u/".length + user.length) || "/";
  return c.env.SUPERVISORS.getByName(user).fetch(new Request(url, c.req.raw));
});

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
