import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { it as effectIt } from '@effect/vitest';

import { maskDisplayValue } from '@cli/chat/tui/input/textInputEditing';
import { formatPersonalApiKeysLine } from '@cli/runtime/apiStatus';
import { maybeRunCliOnboarding } from '@cli/onboarding/runOnboarding';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import {
  readOnboardingFlags,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  FakeSecrets,
  createFakePlatform,
  createFakeWorkspaceRoots,
} from '@test/support/FakePlatform';

/** The gate over the unavailable port: this host has no editor models, and
 *  the gate's type carries the `LanguageModel` requirement regardless. */
const maybeOnboarding = (...args: Parameters<typeof maybeRunCliOnboarding>) =>
  maybeRunCliOnboarding(...args).pipe(
    Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
  );

const ONBOARDING_DECLINED_KEY = GlobalStateKey.ONBOARDING_DECLINED;

describe('onboarding decline flag', () => {
  it('treats a non-boolean stored value as not-declined', async () => {
    const state = new MemoryStateStore();
    await Effect.runPromise(state.update(ONBOARDING_DECLINED_KEY, 'yes'));

    expect(readOnboardingFlags(state).declined).toBe(false);
  });
});

describe('maskDisplayValue', () => {
  it('masks every visible glyph but preserves newlines and length', () => {
    expect(maskDisplayValue('sk-ant-12345')).toBe('••••••••••••');
    expect(maskDisplayValue('sk-ant-12345')).toHaveLength(
      'sk-ant-12345'.length,
    );
    expect(maskDisplayValue('ab\ncd')).toBe('••\n••');
    expect(maskDisplayValue('')).toBe('');
  });
});

describe('maybeRunCliOnboarding headless parity', () => {
  effectIt.effect(
    'returns configured:false on a non-TTY stdout even when marked interactive',
    () =>
      Effect.gen(function* () {
        // The defensive `!process.stdout.isTTY` guard must bail before rendering.
        // Stub isTTY explicitly so the test is deterministic regardless of whether
        // the runner attaches a TTY (vitest locally vs CI).
        const original = process.stdout.isTTY;
        Object.defineProperty(process.stdout, 'isTTY', {
          value: false,
          configurable: true,
        });
        try {
          expect(
            yield* maybeOnboarding(
              {
                ...createFakePlatform(),
                ...createFakeWorkspaceRoots(),
                secrets: new FakeSecrets(),
                runtime: testRuntime(),
              },
              {
                mode: 'interactive',
                stdoutIsTty: true,
                termIsDumb: false,
              },
            ),
          ).toEqual({ configured: false, declined: false });
        } finally {
          Object.defineProperty(process.stdout, 'isTTY', {
            value: original,
            configurable: true,
          });
        }
      }),
  );
});
