/**
 * Shared fetch stubs and response builders for suites that drive HTTP clients
 * through an injected or globally stubbed `fetch`.
 */

// Third-party imports
import { vi, type Mock } from 'vitest';

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

/**
 * Stubs the global `fetch` to immediately resolve every call with `payload`
 * as JSON, and returns the mock for call assertions.
 */
export function stubJsonFetch(payload: unknown): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(payload));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
