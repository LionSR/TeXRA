import { deepStrictEqual, equal } from 'node:assert/strict';

import { INSTALL_ID_HEADER, resolveOwner } from './usageOwner.ts';

const INSTALL_ID = 'a584b784-a4f1-4d44-a99f-36767d31e79d';

function request(headers: Record<string, string>): Request {
  return new Request('https://example.test/log-usage', {
    method: 'POST',
    headers,
  });
}

Deno.test('accepts a well-formed install id without a JWT', async () => {
  deepStrictEqual(
    await resolveOwner(
      request({ [INSTALL_ID_HEADER]: INSTALL_ID.toUpperCase() }),
    ),
    { userId: null, installId: INSTALL_ID },
  );
});

Deno.test('rejects missing, malformed and non-v4 install ids', async () => {
  const cases: Record<string, string>[] = [
    {},
    { [INSTALL_ID_HEADER]: 'not-a-uuid' },
    { [INSTALL_ID_HEADER]: 'a584b784-a4f1-1d44-a99f-36767d31e79d' },
  ];
  for (const headers of cases) {
    equal(await resolveOwner(request(headers)), null);
  }
});

Deno.test(
  'an unauthenticated JWT never falls back to the install id',
  async () => {
    equal(
      await resolveOwner(
        request({
          Authorization: 'Bearer invalid',
          [INSTALL_ID_HEADER]: INSTALL_ID,
        }),
      ),
      null,
    );
  },
);
