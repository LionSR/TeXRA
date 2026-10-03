import { deepStrictEqual, equal } from 'node:assert/strict';

import { INSTALL_ID_HEADER, resolveInstallOwner } from './usageOwner.ts';

const INSTALL_ID = 'a584b784-a4f1-4d44-a99f-36767d31e79d';

function request(headers: Record<string, string>): Request {
  return new Request('https://example.test/log-usage-v2', {
    method: 'POST',
    headers,
  });
}

Deno.test('accepts a well-formed install id and ignores any JWT', async () => {
  deepStrictEqual(
    await resolveInstallOwner(
      request({
        [INSTALL_ID_HEADER]: INSTALL_ID.toUpperCase(),
        Authorization: 'Bearer invalid',
      }),
    ),
    { userId: null, installId: INSTALL_ID },
  );
});

Deno.test('rejects missing, malformed and non-v4 install ids', async () => {
  const cases: Record<string, string>[] = [
    {},
    { Authorization: 'Bearer invalid' },
    { [INSTALL_ID_HEADER]: 'not-a-uuid' },
    { [INSTALL_ID_HEADER]: 'a584b784-a4f1-1d44-a99f-36767d31e79d' },
  ];
  for (const headers of cases) {
    equal(await resolveInstallOwner(request(headers)), null);
  }
});
