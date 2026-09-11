import { Effect } from 'effect';
import { it as effectIt } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration tests for the maybeRunCliOnboarding gate's early-return branches.
// The gate's final guard is `!process.stdout.isTTY`, which is falsy in the
// vitest runner — so to exercise the credential / declined / dumb-terminal
// branches we stub stdout.isTTY = true and mock the gate's collaborators.

const mocks = vi.hoisted(() => ({
  hasUsableSetupCredential: vi.fn(),
  listRuns: vi.fn(),
}));

vi.mock('@model/setupCredentialAccess', () => ({
  hasUsableSetupCredential: mocks.hasUsableSetupCredential,
}));

vi.mock('@agent/storage', () => ({
  listRuns: () => Effect.tryPromise(() => mocks.listRuns()),
}));

vi.mock('@cli/runtime/transcriptSession', () => ({
  initializeCliTranscriptSession: vi.fn(async () => ({})),
}));
vi.mock('@platform/processRuntime', () => ({
  effectRuntime: () => ({ runPromise: Effect.runPromise }),
}));

import { firstRunSetupAgentOverride } from '@cli/onboarding/setupContinuation';
import type { CliPlatformServices } from '@cli/runtime/initPlatform';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createFakePlatform } from '@test/support/FakePlatform';

const { maybeRunCliOnboarding } = await import('@cli/onboarding/runOnboarding');

const INTERACTIVE = {
  mode: 'interactive' as const,
  stdoutIsTty: true,
  termIsDumb: false,
};

/** The gate's early-return result: onboarding skipped, nothing changed. */
const SKIPPED = { configured: false, declined: false };

describe('maybeRunCliOnboarding gate', () => {
  let originalIsTty: unknown;
  // The services bag `initInteractiveCliPlatform` hands its callers, which the
  // gate now reads instead of the ambient platform singleton.
  let services: CliPlatformServices;

  beforeEach(() => {
    mocks.hasUsableSetupCredential.mockReset().mockResolvedValue(false);
    mocks.listRuns.mockReset().mockResolvedValue([]);
    services = createFakePlatform();
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
        mocks.hasUsableSetupCredential.mockResolvedValue(true);
        expect(yield* maybeRunCliOnboarding(services, INTERACTIVE)).toEqual(
          SKIPPED,
        );
        expect(mocks.hasUsableSetupCredential).toHaveBeenCalled();
      }),
  );

  effectIt.effect(
    'marks prior installs with credentials as first-run done',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          services.globalState.update(
            GlobalStateKey.LAST_KNOWN_VERSION,
            '1.2.3',
          ),
        );
        mocks.hasUsableSetupCredential.mockResolvedValue(true);

        expect(yield* maybeRunCliOnboarding(services, INTERACTIVE)).toEqual(
          SKIPPED,
        );
        expect(
          services.globalState.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE),
        ).toBe(true);
      }),
  );

  effectIt.effect(
    'backfills a credentialed fresh install as NOT done (env keys)',
    () =>
      Effect.gen(function* () {
        // Credential alone proves nothing, fresh installs can inherit env keys.
        mocks.hasUsableSetupCredential.mockResolvedValue(true);

        yield* maybeRunCliOnboarding(services, INTERACTIVE);
        expect(
          services.globalState.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE),
        ).toBe(false);
      }),
  );

  effectIt.effect('skips when onboarding was previously declined', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        services.globalState.update(GlobalStateKey.ONBOARDING_DECLINED, true),
      );
      expect(yield* maybeRunCliOnboarding(services, INTERACTIVE)).toEqual(
        SKIPPED,
      );
      expect(mocks.hasUsableSetupCredential).toHaveBeenCalled();
    }),
  );

  effectIt.effect(
    'clears a stale declined flag when credentials now exist',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          services.globalState.update(GlobalStateKey.ONBOARDING_DECLINED, true),
        );
        yield* Effect.promise(() =>
          services.globalState.update(
            GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
            false,
          ),
        );
        mocks.hasUsableSetupCredential.mockResolvedValue(true);

        // `configured` stays false: only the picker actually configuring a
        // credential in this process is a post-picker continuation. A pre-existing
        // credential must not route every launch into the setup agent.
        expect(yield* maybeRunCliOnboarding(services, INTERACTIVE)).toEqual(
          SKIPPED,
        );
        expect(
          services.globalState.get(GlobalStateKey.ONBOARDING_DECLINED),
        ).toBe(false);
      }),
  );

  effectIt.effect(
    'skips onboarding for credential-less users with prior run history',
    () =>
      Effect.gen(function* () {
        mocks.listRuns.mockResolvedValue([{ id: 'previous-run' }]);

        expect(yield* maybeRunCliOnboarding(services, INTERACTIVE)).toEqual(
          SKIPPED,
        );
        expect(
          services.globalState.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE),
        ).toBe(true);
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
      expect(yield* maybeRunCliOnboarding(services, options)).toEqual(SKIPPED);
      expect(mocks.hasUsableSetupCredential).not.toHaveBeenCalled();
    }),
  );
});

// State 1 continuation (.agents/docs/archived/feature/2026-06-11-agent-native-onboarding.md): after the gate
// configures a credential on a true first run, chat/orchestrate start the
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
      scenario:
        'does nothing once the first run is done (backfilled or earned)',
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
