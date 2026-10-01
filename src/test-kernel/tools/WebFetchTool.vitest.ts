import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, vi } from 'vitest';

import { fetch as undiciFetch } from 'undici';

import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { WebFetchTool } from '@tools/web/WebFetchTool';

// The tool connects through undici's own `fetch`; the real one stays the
// default, and a test stubs one response.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});

// The dispatcher reads the proxy environment once, so clear what the shell
// may export before the first fetch; a test that wants a proxy stubs its own.
const PROXY_ENV = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
];
function clearProxyEnv() {
  for (const name of PROXY_ENV) vi.stubEnv(name, undefined);
}

describe('WebFetchTool', () => {
  beforeAll(clearProxyEnv);
  afterAll(() => vi.unstubAllEnvs());

  it.effect.each([
    // Loopback and RFC 1918 private ranges.
    { url: 'http://127.0.0.1/', name: 'IPv4 loopback' },
    { url: 'http://[::1]/', name: 'bracketed IPv6 loopback' },
    { url: 'http://10.0.0.1/', name: 'RFC 1918 private range' },
    // Carrier-grade NAT (RFC 6598) — missed by the old prefix-list check.
    { url: 'http://100.64.0.1/', name: 'carrier-grade NAT range' },
    // IPv4-mapped IPv6 loopback, in the bracketed form a URL actually
    // produces — bypassed both the old IPv6-prefix-only check and an
    // unbracketed `ipaddr.isValid` call.
    {
      url: 'http://[::ffff:127.0.0.1]/',
      name: 'bracketed IPv4-mapped IPv6 loopback',
    },
    // DNS64/NAT64 wraps an IPv4 address; the wrapped address decides.
    { url: 'http://[64:ff9b::7f00:1]/', name: 'NAT64-wrapped IPv4 loopback' },
    { url: 'http://localhost/', name: 'the localhost hostname' },
  ])('rejects a fetch to $name', ({ url }) =>
    Effect.gen(function* () {
      const result = yield* WebFetchTool.call({ url }).pipe(
        Effect.provide(nativeToolTestLayer()),
      );

      expect(result).toMatchObject({ status: 'error' });
      expect(result.error).toMatch(/cannot fetch/i);
    }),
  );

  it.effect('rejects a redirect from a public host to a private address', () =>
    Effect.gen(function* () {
      // The metadata address a cloud instance serves credentials from.
      const fetchStub = vi.mocked(undiciFetch).mockClear();
      fetchStub.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
        }) as unknown as Awaited<ReturnType<typeof undiciFetch>>,
      );

      const result = yield* WebFetchTool.call({
        url: 'http://93.184.216.34/',
      }).pipe(Effect.provide(nativeToolTestLayer()));

      expect(result).toMatchObject({ status: 'error' });
      expect(result.error).toMatch(/cannot fetch/i);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    }),
  );

  // With only HTTPS_PROXY set, an http:// URL connects directly; the guard
  // must hold on that path too. A fresh module builds a fresh dispatcher,
  // which reads the environment once.
  it.effect('rejects localhost over a direct path while a proxy is set', () =>
    Effect.gen(function* () {
      vi.stubEnv('HTTPS_PROXY', 'http://192.0.2.1:3128');
      vi.resetModules();
      const { WebFetchTool: proxied } = yield* Effect.promise(
        () => import('@tools/web/WebFetchTool'),
      );

      const result = yield* proxied
        .call({ url: 'http://localhost/' })
        .pipe(Effect.provide(nativeToolTestLayer()));

      expect(result).toMatchObject({ status: 'error' });
      expect(result.error).toMatch(/cannot fetch/i);
    }).pipe(Effect.ensuring(Effect.sync(clearProxyEnv))),
  );
});
