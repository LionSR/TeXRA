import { afterEach, describe, expect, it } from 'vitest';

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

    expect(await getExternalAuthCallbackInfo()).toEqual({
      fullUrl: 'https://example.test/extension-auth-callback?state=state-value',
    });
  });

  it('falls back without importing host APIs', async () => {
    expect(await getExternalAuthCallbackInfo()).toEqual({
      fullUrl: 'vscode://texra-ai.texra/auth-callback',
    });
  });
});
