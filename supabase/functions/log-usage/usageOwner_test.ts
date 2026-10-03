import { equal } from 'node:assert/strict';

import { resolveJwtOwner } from './usageOwner.ts';

const INSTALL_ID = 'a584b784-a4f1-4d44-a99f-36767d31e79d';

Deno.test(
  'a missing or invalid bearer is rejected; the install id is never read',
  async () => {
    for (const headers of <Record<string, string>[]>[
      {},
      { Authorization: 'Bearer invalid' },
      { Authorization: 'Bearer invalid', 'X-TeXRA-Install-Id': INSTALL_ID },
      { 'X-TeXRA-Install-Id': INSTALL_ID },
    ]) {
      equal(
        await resolveJwtOwner(
          new Request('https://example.test/log-usage', {
            method: 'POST',
            headers,
          }),
        ),
        null,
      );
    }
  },
);
