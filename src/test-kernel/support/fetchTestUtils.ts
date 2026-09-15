/**
 * Shared fetch response builders and a fetch layer for suites that drive HTTP
 * clients through an injected `fetch`, including a layer that still reads a
 * globally stubbed `globalThis.fetch` at request time.
 */

// Third-party imports
import { Layer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

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

/** Use each test's current fetch stub even when the client layer is shared. */
export const testHttpClientLayer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch)((input, init) =>
      globalThis.fetch(input, init),
    ),
  ),
);
