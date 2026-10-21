// A request stays inflight through EOF, errors, or cancellation, not just headers.
export function trackResponseBody(
  response: Response,
  ctx: DurableObjectState,
  release: () => void,
): Response {
  if (!response.body) {
    release();
    return response;
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  ctx.waitUntil(
    response.body.pipeTo(writable)
      .catch(error => {
        console.log("response body ended with error/cancellation", String(error));
      })
      .finally(release),
  );
  return new Response(readable, response);
}
