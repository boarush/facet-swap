import { Hono } from "hono";

export function createRouter<Bindings extends object>() {
  return new Hono<{ Bindings: Bindings }>({
    // Keep encoded paths literal.
    getPath: (request) => new URL(request.url).pathname,
  })
    .use(async (c, next) => {
      await next();
      // Hono strips HEAD bodies; cancel first so a discarded SSE body releases inflight.
      if (c.req.method === "HEAD") await c.res.body?.cancel();
    })
    .notFound(() => new Response("Not found", { status: 404 }))
    .onError((error) => {
      // Let the runtime handle failures; routing must not swallow facet aborts.
      throw error;
    });
}
