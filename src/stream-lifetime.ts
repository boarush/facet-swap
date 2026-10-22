export type UpdateAbort = {
  reason: "drain-deadline";
  oldVersion: string;
  newVersion: string;
};

// Own the outer body so facet abort cannot swallow the final SSE retry hint.
export function trackResponseBody(
  response: Response,
  signal: AbortSignal,
  release: () => void,
): Response {
  if (!response.body) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  const isEventStream =
    response.headers.get("content-type")?.split(";")[0].trim() === "text/event-stream";
  let ended = false;
  let onAbort: () => void;
  const finish = () => {
    ended = true;
    signal.removeEventListener("abort", onAbort);
    release();
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (ended) return;
        if (isEventStream) {
          // The boundary also separates any partially delivered source frame.
          controller.enqueue(
            new TextEncoder().encode(
              "\n\nevent: update-abort\ndata: " + JSON.stringify(signal.reason) + "\n\n",
            ),
          );
          controller.close();
        } else {
          controller.error(new Error("Drain deadline exceeded"));
        }
        finish();
        void reader.cancel(signal.reason).catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (ended) return;
        if (done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (ended) return;
        controller.error(error);
        finish();
      }
    },
    cancel(reason) {
      if (ended) return;
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(body, response);
}
