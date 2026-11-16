/**
 * Shared fetch response builders for suites that drive HTTP clients through an
 * injected `fetch`.
 */

// Third-party imports
import { Effect, Layer } from 'effect';
import { HttpClient } from 'effect/http';

/**
 * Builds a fetch-compatible `Response` from a JSON-serializable body, for
 * tests that serve a scripted fetch through `FetchHttpClient.Fetch`.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The HTTP client of a suite that answers no HTTP: any request dies, so an
 *  unexpected one fails the test instead of reaching the network. */
export const noHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request) =>
    Effect.die(
      new Error(`unexpected HTTP request: ${request.method} ${request.url}`),
    ),
  ),
);
