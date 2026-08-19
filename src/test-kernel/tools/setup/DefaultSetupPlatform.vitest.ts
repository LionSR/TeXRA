// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { SupabaseClient } from '@auth/SupabaseClient';
import * as codexAuth from '@auth/codex';
import * as providerCapabilities from '@model/providerCapabilities';
import { platform } from '@platform/platform';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  __resetSetupPlatformForTests,
  getChatGptSubscriptionStatus,
  getSetupAuthStatus,
  getSetupPlatform,
  setSetupPlatform,
  setupSecrets,
  texraScopedConfig,
} from '@tools/setup/platform';

setupPlatform({
  config: { 'texra.bib.defaultPath': 'references.bib' },
  secrets: { 'apiKey.openai': 'sk-stored-key' },
  secretsEnv: { GITHUB_TOKEN: 'github-env-token' },
});

afterEach(() => {
  vi.restoreAllMocks();
  SupabaseClient.resetForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  __resetSetupPlatformForTests();
  setSetupPlatform({ host: 'extension', signIn: async () => false });
});

describe('shared setup capabilities', () => {
  it('derives credential and configuration operations from platform ports', async () => {
    const setup = getSetupPlatform();

    expect(setup.host).toBe('extension');
    expect(setup.commands).toBeUndefined();
    expect(setup.extensions).toBeUndefined();
    expect(setup.terminal).toBeUndefined();
    await expect(setupSecrets.storedApiKeyExists('openai')).resolves.toBe(true);
    await expect(setupSecrets.hasUsableApiKey('openai')).resolves.toBe(true);
    await expect(setupSecrets.gitHubTokenExists()).resolves.toBe('env');
    await expect(setupSecrets.listStoredKeys()).resolves.toContain(
      'apiKey.openai',
    );

    expect(texraScopedConfig.get('texra.bib.defaultPath')).toBe(
      'references.bib',
    );
    await texraScopedConfig.update('texra.bib.defaultPath', 'main.bib', 'user');
    expect(
      platform().config.inspect('texra.bib.defaultPath')?.globalValue,
    ).toBe('main.bib');
  });

  it('keeps the configuration boundary at texra.* keys', () => {
    expect(() => texraScopedConfig.get('editor.fontSize')).toThrow(
      'Setup config adapter is scoped to texra.* keys',
    );
  });

  it('recognizes a stored key even when its value cannot be read', async () => {
    vi.spyOn(platform().secrets, 'getStored').mockResolvedValue(undefined);
    vi.spyOn(platform().secrets, 'listStoredKeys').mockResolvedValue([
      'apiKey.openai',
    ]);

    await expect(setupSecrets.storedApiKeyExists('openai')).resolves.toBe(true);
  });

  it('reports a signed-in account with remote-catalog access', async () => {
    vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(true);
    vi.spyOn(SupabaseClient, 'getUser').mockResolvedValue(null);

    await expect(getSetupAuthStatus()).resolves.toEqual({
      authenticated: true,
      remoteAgentCatalogAvailable: true,
      email: undefined,
    });
  });

  it('keeps API-key-only setup usable without reporting sign-in', async () => {
    await expect(setupSecrets.anyUsableCredentialExists()).resolves.toBe(true);
    await expect(getSetupAuthStatus()).resolves.toEqual({
      authenticated: false,
      remoteAgentCatalogAvailable: false,
    });
  });

  it('does not expose ChatGPT account identifiers through setup tools', async () => {
    vi.spyOn(codexAuth, 'getCodexStatus').mockResolvedValue({
      signedIn: true,
      email: 'researcher@example.com',
      accountId: 'account-private-id',
    });

    const status = await getChatGptSubscriptionStatus();

    expect(status.signedIn).toBe(true);
    expect(status).not.toHaveProperty('account');
    expect(JSON.stringify(status)).not.toContain('researcher@example.com');
    expect(JSON.stringify(status)).not.toContain('account-private-id');
  });

  it('reports ChatGPT as disabled when runtime routing cannot use it', async () => {
    vi.spyOn(codexAuth, 'getCodexStatus').mockResolvedValue({
      signedIn: true,
      email: 'researcher@example.com',
    });
    vi.spyOn(
      providerCapabilities,
      'isCodexSubscriptionActive',
    ).mockResolvedValue(false);

    await expect(getChatGptSubscriptionStatus()).resolves.toEqual({
      signedIn: true,
      enabled: false,
    });
  });
});
