import { Effect } from 'effect';
import { it as effectIt } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration tests for the maybeRunCliOnboarding gate's early-return branches.
// The gate's final guard is `!process.stdout.isTTY`, which is falsy in the
// vitest runner — so to exercise the credential / declined / dumb-terminal
// branches we stub stdout.isTTY = true and mock the gate's collaborators.

const mocks = vi.hoisted(() => ({
  hasUsableSetupCredential: vi.fn(),
}));

vi.mock('@model/setupCredentialAccess', () => ({
  hasUsableSetupCredential: mocks.hasUsableSetupCredential,
}));

import { firstRunSetupAgentOverride } from '@cli/onboarding/setupContinuation';
import type { ModelOptionStores } from '@model/computeModelOptions';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import type { ProcessRuntime } from '@platform/processRuntime';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  FakeSecrets,
  createFakePlatform,
  createFakeWorkspaceRoots,
} from '@test/support/FakePlatform';

const { maybeRunCliOnboarding } = await import('@cli/onboarding/runOnboarding');

/** The gate over the unavailable port: the credential probe is mocked, but
 *  the program's type keeps the real signature's `LanguageModel` requirement. */
const maybeOnboarding = (...args: Parameters<typeof maybeRunCliOnboarding>) =>
  maybeRunCliOnboarding(...args).pipe(
    Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
  );

const INTERACTIVE = {
  mode: 'interactive' as const,
  stdoutIsTty: true,
  termIsDumb: false,
};

/** The gate's early-return result: onboarding skipped, nothing changed. */
const SKIPPED = { configured: false, declined: false };

describe('maybeRunCliOnboarding gate', () => {
  let originalIsTty: unknown;
  // The services bag `initCliPlatform` hands its callers, which the gate now
  // reads instead of the ambient platform singleton.
  let services: ModelOptionStores & { readonly runtime: ProcessRuntime };

  beforeEach(() => {
    mocks.hasUsableSetupCredential
      .mockReset()
      .mockReturnValue(Effect.succeed(false));
    services = {
      ...createFakePlatform(),
      ...createFakeWorkspaceRoots(),
      secrets: new FakeSecrets(),
      runtime: testRuntime(),
    };
    originalIsTty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTty,
      configurable: true,
    });
  });

  effectIt.effect(
    'skips (configured:false) when the user already has a credential',
    () =>
      Effect.gen(function* () {
        mocks.hasUsableSetupCredential.mockReturnValue(Effect.succeed(true));
        expect(yield* maybeOnboarding(services, INTERACTIVE)).toEqual(SKIPPED);
        expect(mocks.hasUsableSetupCredential).toHaveBeenCalled();
      }),
  );

  effectIt.effect('skips when onboarding was previously declined', () =>
    Effect.gen(function* () {
      yield* services.globalState.update(
        GlobalStateKey.ONBOARDING_DECLINED,
        true,
      );
      expect(yield* maybeOnboarding(services, INTERACTIVE)).toEqual(SKIPPED);
      expect(mocks.hasUsableSetupCredential).toHaveBeenCalled();
    }),
  );

  effectIt.effect(
    'clears a stale declined flag when credentials now exist',
    () =>
      Effect.gen(function* () {
        yield* services.globalState.update(
          GlobalStateKey.ONBOARDING_DECLINED,
          true,
        );
        mocks.hasUsableSetupCredential.mockReturnValue(Effect.succeed(true));

        // `configured` stays false: only the picker actually configuring a
        // credential in this process is a post-picker continuation. A pre-existing
        // credential must not route every launch into the setup agent.
        expect(yield* maybeOnboarding(services, INTERACTIVE)).toEqual(SKIPPED);
        expect(
          yield* services.globalState.get(GlobalStateKey.ONBOARDING_DECLINED),
        ).toBe(false);
      }),
  );

  effectIt.effect.each([
    {
      scenario: 'on a dumb terminal',
      options: { ...INTERACTIVE, termIsDumb: true },
    },
    {
      scenario: 'in headless mode',
      options: { ...INTERACTIVE, mode: 'headless' as const },
    },
  ])('skips $scenario before checking credentials', ({ options }) =>
    Effect.gen(function* () {
      expect(yield* maybeOnboarding(services, options)).toEqual(SKIPPED);
      expect(mocks.hasUsableSetupCredential).not.toHaveBeenCalled();
    }),
  );
});

// State 1 continuation (.agents/docs/archived/feature/2026-06-11-agent-native-onboarding.md): after the gate
// configures a credential on a true first run, chat starts the
// session with the setup agent instead of the default agent / launcher.
describe('firstRunSetupAgentOverride', () => {
  it.each([
    {
      scenario: 'hands the session to the setup agent on a true first run',
      input: { onboardingConfigured: true, firstRunDone: false },
      expected: SETUP_AGENT_NAME as string | undefined,
    },
    {
      scenario:
        'does nothing when onboarding did not just configure a credential',
      input: { onboardingConfigured: false, firstRunDone: false },
      expected: undefined,
    },
    {
      scenario: 'does nothing once the first run is done',
      input: { onboardingConfigured: true, firstRunDone: true },
      expected: undefined,
    },
    {
      scenario: 'never displaces an agent the user pinned themselves',
      input: {
        onboardingConfigured: true,
        firstRunDone: false,
        pinnedAgent: 'research',
      },
      expected: undefined,
    },
    {
      scenario: 'ignores a blank pinned agent',
      input: {
        onboardingConfigured: true,
        firstRunDone: false,
        pinnedAgent: '   ',
      },
      expected: SETUP_AGENT_NAME as string | undefined,
    },
  ])('$scenario', ({ input, expected }) => {
    expect(firstRunSetupAgentOverride(input)).toBe(expected);
  });
});
