/**
 * Builds a fetch-compatible `Response` from a JSON-serializable body, for
 * tests that stub `fetchImpl` against a queued/single mock fetch.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
