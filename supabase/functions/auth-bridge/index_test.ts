import { match, strictEqual } from 'node:assert/strict';

import { handleRequest } from './index.ts';

const NONCE = '0123456789abcdef0123456789abcdef';

Deno.test('auth bridge requires and binds the callback nonce', async () => {
  const missingNonce = handleRequest(
    new Request(
      'https://remote.texra.ai/functions/v1/auth-bridge/vscode/texra-ai.texra?code=test',
    ),
  );
  strictEqual(missingNonce.status, 400);
  match(
    await missingNonce.text(),
    /This sign-in link is missing its security nonce\./,
  );

  const bound = handleRequest(
    new Request(
      `https://remote.texra.ai/functions/v1/auth-bridge/vscode/texra-ai.texra/${NONCE}?code=test&app_nonce=attacker`,
    ),
  );
  strictEqual(bound.status, 200);
  const html = await bound.text();
  match(html, new RegExp(`var APP_NONCE = "${NONCE}";`));
  match(html, /callbackParams\.delete\('app_nonce'\);/);
  match(html, /callbackParams\.append\('app_nonce', APP_NONCE\);/);
});

Deno.test('auth bridge rejects malformed nonce and extra path segments', () => {
  for (const path of [
    '/functions/v1/auth-bridge/vscode/texra-ai.texra/not-a-nonce',
    `/functions/v1/auth-bridge/vscode/texra-ai.texra/${NONCE}/extra`,
  ]) {
    const response = handleRequest(
      new Request(`https://remote.texra.ai${path}`),
    );
    strictEqual(response.status, 400);
  }
});
