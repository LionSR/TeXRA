// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
