/**
 * Shared fetch stubs and response builders for suites that drive HTTP clients
 * through an injected or globally stubbed `fetch`.
 */

// Third-party imports
import { Layer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { vi, type Mock } from 'vitest';
import { effectNodeFileSystemLayer } from '@platform/defaults/effectNodeFileSystem';

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

/** Use each test's current fetch stub even when the client layer is shared. */
export const testHttpClientLayer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch)((input, init) =>
      globalThis.fetch(input, init),
    ),
  ),
);

/**
 * The services a `ProcessRuntime` must carry, for tests that install one.
 * Kept beside the http layer so widening `ProcessRuntime` touches one place
 * rather than every test that calls `initProcessRuntime`.
 */
export const testProcessRuntimeLayer = Layer.mergeAll(
  testHttpClientLayer,
  effectNodeFileSystemLayer,
);
