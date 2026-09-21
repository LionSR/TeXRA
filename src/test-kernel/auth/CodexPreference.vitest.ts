// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

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
  it.effect(
    'writes workspace preference when workspace config already controls it',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            config: { [CODEX_PREFER_SUBSCRIPTION_KEY]: false },
          }),
        );

        const update = yield* setPreferCodexSubscription(
          testWorkspaceRoots(),
          true,
        );

        expect(update).toEqual({ effective: true, target: 'workspace' });
        expect(isPreferCodexSubscription(testWorkspaceRoots())).toBe(true);
        expect(
          testWorkspaceRoots().config.inspect(CODEX_PREFER_SUBSCRIPTION_KEY),
        ).toMatchObject({
          workspaceValue: true,
        });
      }),
  );

  it.effect(
    'does not treat folder overrides as writable workspace config',
    () =>
      Effect.gen(function* () {
        const config = new FakeScopedConfigProvider();
        config.seedWorkspaceFolder(CODEX_PREFER_SUBSCRIPTION_KEY, false);
        yield* Effect.promise(() => installPlatform({}, { config }));

        const update = yield* setPreferCodexSubscription(
          testWorkspaceRoots(),
          true,
        );

        expect(update).toEqual({ effective: false, target: 'global' });
        expect(isPreferCodexSubscription(testWorkspaceRoots())).toBe(false);
        expect(config.inspect(CODEX_PREFER_SUBSCRIPTION_KEY)).toMatchObject({
          globalValue: true,
        });
      }),
  );
});
