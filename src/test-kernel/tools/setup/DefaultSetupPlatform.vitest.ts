// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { platform } from '@platform/platform';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  __resetSetupPlatformForTests,
  getSetupPlatform,
} from '@tools/setup/platform';

setupPlatform({
  config: { 'texra.bib.defaultPath': 'references.bib' },
  secrets: { 'apiKey.openai': 'sk-stored-key' },
  secretsEnv: { GITHUB_TOKEN: 'github-env-token' },
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetSetupPlatformForTests();
});

beforeEach(() => {
  __resetSetupPlatformForTests();
});

describe('default setup platform', () => {
  it('derives credential and configuration operations from platform ports', async () => {
    const setup = getSetupPlatform();

    expect(setup.commands).toBeUndefined();
    expect(setup.extensions).toBeUndefined();
    expect(setup.terminal).toBeUndefined();
    await expect(setup.secrets.storedApiKeyExists('openai')).resolves.toBe(
      true,
    );
    await expect(setup.secrets.hasUsableApiKey('openai')).resolves.toBe(true);
    await expect(setup.secrets.gitHubTokenExists()).resolves.toBe('env');
    await expect(setup.secrets.listStoredKeys()).resolves.toContain(
      'apiKey.openai',
    );

    expect(setup.config.get('texra.bib.defaultPath')).toBe('references.bib');
    await setup.config.update('texra.bib.defaultPath', 'main.bib', 'user');
    expect(
      platform().config.inspect('texra.bib.defaultPath')?.globalValue,
    ).toBe('main.bib');
  });

  it('keeps the configuration boundary at texra.* keys', () => {
    expect(() => getSetupPlatform().config.get('editor.fontSize')).toThrow(
      'Setup config adapter is scoped to texra.* keys',
    );
  });

  it('recognizes a stored key even when its value cannot be read', async () => {
    vi.spyOn(platform().secrets, 'getStored').mockResolvedValue(undefined);
    vi.spyOn(platform().secrets, 'listStoredKeys').mockResolvedValue([
      'apiKey.openai',
    ]);

    await expect(
      getSetupPlatform().secrets.storedApiKeyExists('openai'),
    ).resolves.toBe(true);
  });
});
