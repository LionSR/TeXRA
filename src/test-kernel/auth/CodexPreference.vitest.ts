// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  CODEX_PREFER_SUBSCRIPTION_KEY,
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@model/codex/codexPreference';
import { platform } from '@platform/platform';
import { installPlatform } from '@test/support/setupPlatform';
import { FakeScopedConfigProvider } from '@test/support/FakePlatform';

describe('Codex subscription preference', () => {
  it('writes workspace preference when workspace config already controls it', async () => {
    await installPlatform({
      config: { [CODEX_PREFER_SUBSCRIPTION_KEY]: false },
    });

    const update = await setPreferCodexSubscription(true);

    expect(update).toEqual({ effective: true, target: 'workspace' });
    expect(isPreferCodexSubscription()).toBe(true);
    expect(
      platform().config.inspect(CODEX_PREFER_SUBSCRIPTION_KEY),
    ).toMatchObject({
      workspaceValue: true,
    });
  });

  it('does not treat folder overrides as writable workspace config', async () => {
    const config = new FakeScopedConfigProvider();
    config.seedWorkspaceFolder(CODEX_PREFER_SUBSCRIPTION_KEY, false);
    await installPlatform({}, { config });

    const update = await setPreferCodexSubscription(true);

    expect(update).toEqual({ effective: false, target: 'global' });
    expect(isPreferCodexSubscription()).toBe(false);
    expect(config.inspect(CODEX_PREFER_SUBSCRIPTION_KEY)).toMatchObject({
      globalValue: true,
      workspaceFolderValue: false,
    });
  });
});
