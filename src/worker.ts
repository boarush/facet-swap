import type { Env } from "./env";
import { publishLocally } from "./dev-publish";

export { Supervisor } from "./supervisor";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ready");
    const published = await publishLocally(request, env);
    if (published) return published;
    const match = /^\/u\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    url.pathname = match[2] ?? "/";
    return env.SUPERVISORS.get(env.SUPERVISORS.idFromName(match[1])).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
