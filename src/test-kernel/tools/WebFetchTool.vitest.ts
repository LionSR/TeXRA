import { describe, expect, it } from 'vitest';

import { isRestrictedIp } from '@tools/web/WebFetchTool';

describe('isRestrictedIp', () => {
  it.each([
    // Public addresses are let through.
    { hostname: '93.184.216.34', expected: false },
    { hostname: '2606:2800:220:1:248:1893:25c8:1946', expected: false },
    // A bare hostname is not an IP literal at all; DNS-level SSRF is out of
    // scope for this hostname-string check.
    { hostname: 'example.com', expected: false },
    // Loopback.
    { hostname: '127.0.0.1', expected: true },
    { hostname: '::1', expected: true },
    // RFC 1918 private ranges.
    { hostname: '10.0.0.1', expected: true },
    { hostname: '192.168.1.1', expected: true },
    { hostname: '172.16.0.1', expected: true },
    { hostname: '172.31.255.255', expected: true },
    // Link-local and unspecified.
    { hostname: '169.254.169.254', expected: true },
    { hostname: '0.0.0.0', expected: true },
    { hostname: 'fe80::1', expected: true },
    // IPv6 unique-local.
    { hostname: 'fd00::1', expected: true },
    // Carrier-grade NAT (RFC 6598) — missed by the old prefix-list check.
    { hostname: '100.64.0.1', expected: true },
    // IPv4-mapped IPv6 loopback — bypassed the old IPv6-prefix-only check.
    { hostname: '::ffff:127.0.0.1', expected: true },
  ])(
    'classifies $hostname as restricted=$expected',
    ({ hostname, expected }) => {
      expect(isRestrictedIp(hostname)).toBe(expected);
    },
  );
});
