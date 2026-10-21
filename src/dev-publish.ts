import type { Env } from "../alchemy.run";

// Local-only: Alchemy refuses non-dev mode and binds this gateway to loopback.
// Reaching it permits code execution; never expose or tunnel the dev server.
export async function publishLocally(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/__local/code" && request.method === "PUT") {
    const code = await request.text();
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const hash = Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
    await env.CODE.put("code/" + hash + ".js", code);
    return Response.json({ hash });
  }
  if (url.pathname === "/__local/latest" && request.method === "PUT") {
    const hash = await request.text();
    if (!/^[a-f0-9]{64}$/.test(hash) || !await env.CODE.head("code/" + hash + ".js")) {
      return new Response("Missing/invalid code hash", { status: 400 });
    }
    await env.VERSIONS.put("latest", hash);
    return Response.json({ hash });
  }
  return null;
}
