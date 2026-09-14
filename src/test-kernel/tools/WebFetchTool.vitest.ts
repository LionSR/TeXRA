import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { WebFetchTool } from '@tools/web/WebFetchTool';

describe('WebFetchTool', () => {
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
    { url: 'http://localhost/', name: 'the localhost hostname' },
  ])('rejects a fetch to $name', ({ url }) =>
    Effect.gen(function* () {
      const result = yield* new WebFetchTool()
        .call({ url })
        .pipe(Effect.provide(nativeToolTestLayer()));

      expect(result).toMatchObject({ status: 'error' });
      expect(result.error).toMatch(/cannot fetch/i);
    }),
  );
});
