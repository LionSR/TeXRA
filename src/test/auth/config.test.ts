import { strict as assert } from 'assert';

import {
  getExternalAuthCallbackInfo,
  setExternalAuthCallbackResolver,
} from '@auth/config';

describe('auth config', () => {
  afterEach(() => {
    setExternalAuthCallbackResolver(null);
  });

  it('uses a host-provided external callback resolver', async () => {
    setExternalAuthCallbackResolver(async () => ({
      baseUrl: 'https://example.test/extension-auth-callback',
      vscodeState: 'state-value',
      fullUrl: 'https://example.test/extension-auth-callback?state=state-value',
    }));

    assert.deepEqual(await getExternalAuthCallbackInfo(), {
      baseUrl: 'https://example.test/extension-auth-callback',
      vscodeState: 'state-value',
      fullUrl: 'https://example.test/extension-auth-callback?state=state-value',
    });
  });

  it('falls back without importing host APIs', async () => {
    assert.deepEqual(await getExternalAuthCallbackInfo(), {
      baseUrl: 'vscode://texra-ai.texra/auth-callback',
      vscodeState: null,
      fullUrl: 'vscode://texra-ai.texra/auth-callback',
    });
  });
});
