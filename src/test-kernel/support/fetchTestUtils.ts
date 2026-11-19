/**
 * Shared fetch response builders for suites that drive HTTP clients through an
 * injected `fetch`.
 */

// Third-party imports
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';

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

/**
 * An HTTP client that answers each request from `answer` and reaches no
 * network. `requests` records every request asked for, in order.
 */
export function scriptedHttpClientLayer(
  answer: (request: HttpClientRequest.HttpClientRequest) => Response,
): {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: HttpClientRequest.HttpClientRequest[];
} {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(request, answer(request));
    }),
  );
  return {
    layer: Layer.succeed(HttpClient.HttpClient)(client),
    requests,
  };
}
