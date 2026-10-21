import type { Env } from "../alchemy.run";

export { Supervisor } from "./supervisor";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ready");
    if (url.pathname === "/__local/publication") {
      const latest = await env.VERSIONS.getWithMetadata<{ publication: string; version: string }>("latest");
      const object = latest.value ? await env.CODE.head("code/" + latest.value + ".js") : null;
      return Response.json({ hash: latest.value, metadata: latest.metadata,
        uploaded: object?.uploaded.toISOString() });
    }
    const match = /^\/u\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    url.pathname = match[2] ?? "/";
    return env.SUPERVISORS.get(env.SUPERVISORS.idFromName(match[1])).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
