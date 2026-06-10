import { strict as assert } from 'node:assert';

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
      fullUrl: 'https://example.test/extension-auth-callback?state=state-value',
    }));

    assert.deepEqual(await getExternalAuthCallbackInfo(), {
      fullUrl: 'https://example.test/extension-auth-callback?state=state-value',
    });
  });

  it('falls back without importing host APIs', async () => {
    assert.deepEqual(await getExternalAuthCallbackInfo(), {
      fullUrl: 'vscode://texra-ai.texra/auth-callback',
    });
  });
});
