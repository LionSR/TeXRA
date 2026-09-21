// Third-party imports
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

// Local imports
import {
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@model/codex/codexSubscription';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform } from '@test/support/setupPlatform';
import { FakeScopedConfigProvider } from '@test/support/FakePlatform';

const CODEX_PREFER_SUBSCRIPTION_KEY = 'texra.chatgptCodex.preferSubscription';

describe('Codex subscription preference (src/model/codex/codexSubscription.ts)', () => {
  it('writes workspace preference when workspace config already controls it', async () => {
    await installPlatform({
      config: { [CODEX_PREFER_SUBSCRIPTION_KEY]: false },
    });

    const update = await Effect.runPromise(
      setPreferCodexSubscription(testWorkspaceRoots(), true),
    );

    expect(update).toEqual({ effective: true, target: 'workspace' });
    expect(isPreferCodexSubscription(testWorkspaceRoots())).toBe(true);
    expect(
      testWorkspaceRoots().config.inspect(CODEX_PREFER_SUBSCRIPTION_KEY),
    ).toMatchObject({
      workspaceValue: true,
    });
  });

  it('does not treat folder overrides as writable workspace config', async () => {
    const config = new FakeScopedConfigProvider();
    config.seedWorkspaceFolder(CODEX_PREFER_SUBSCRIPTION_KEY, false);
    await installPlatform({}, { config });

    const update = await Effect.runPromise(
      setPreferCodexSubscription(testWorkspaceRoots(), true),
    );

    expect(update).toEqual({ effective: false, target: 'global' });
    expect(isPreferCodexSubscription(testWorkspaceRoots())).toBe(false);
    expect(config.inspect(CODEX_PREFER_SUBSCRIPTION_KEY)).toMatchObject({
      globalValue: true,
    });
  });
});
