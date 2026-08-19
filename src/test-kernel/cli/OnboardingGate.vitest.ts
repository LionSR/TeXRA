import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration tests for the maybeRunCliOnboarding gate's early-return branches.
// The gate's final guard is `!process.stdout.isTTY`, which is falsy in the
// vitest runner — so to exercise the credential / declined / dumb-terminal
// branches we stub stdout.isTTY = true and mock the gate's collaborators.

const mocks = vi.hoisted(() => ({
  hasCliRunCredential: vi.fn(),
  listExecutions: vi.fn(),
  state: new Map<string, unknown>(),
}));

vi.mock('@cli/runtime/credentialStatus', () => ({
  hasCliRunCredential: mocks.hasCliRunCredential,
}));

vi.mock('@agent/storage', () => ({
  listExecutions: mocks.listExecutions,
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({
    globalState: {
      get: (key: string, defaultValue?: unknown) =>
        mocks.state.has(key) ? mocks.state.get(key) : defaultValue,
      update: async (key: string, value: unknown) => {
        mocks.state.set(key, value);
      },
    },
  }),
}));

import { firstRunSetupAgentOverride } from '@cli/onboarding/setupContinuation';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { GlobalStateKey } from '@shared/state/stateKeys';

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

  beforeEach(() => {
    mocks.hasCliRunCredential.mockReset().mockResolvedValue(false);
    mocks.listExecutions.mockReset().mockResolvedValue([]);
    mocks.state.clear();
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

  it('skips (configured:false) when the user already has a credential', async () => {
    mocks.hasCliRunCredential.mockResolvedValue(true);
    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual(SKIPPED);
    expect(mocks.hasCliRunCredential).toHaveBeenCalled();
  });

  it('marks prior installs with credentials as first-run done', async () => {
    mocks.state.set(GlobalStateKey.LAST_KNOWN_VERSION, '1.2.3');
    mocks.hasCliRunCredential.mockResolvedValue(true);

    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual(SKIPPED);
    expect(mocks.state.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE)).toBe(
      true,
    );
  });

  it('backfills a credentialed fresh install as NOT done (env keys)', async () => {
    // Credential alone proves nothing — fresh installs can inherit env keys.
    mocks.hasCliRunCredential.mockResolvedValue(true);

    await maybeRunCliOnboarding(INTERACTIVE);
    expect(mocks.state.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE)).toBe(
      false,
    );
  });

  it('skips when onboarding was previously declined', async () => {
    mocks.state.set(GlobalStateKey.ONBOARDING_DECLINED, true);
    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual(SKIPPED);
    expect(mocks.hasCliRunCredential).toHaveBeenCalled();
  });

  it('clears a stale declined flag when credentials now exist', async () => {
    mocks.state.set(GlobalStateKey.ONBOARDING_DECLINED, true);
    mocks.state.set(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE, false);
    mocks.hasCliRunCredential.mockResolvedValue(true);

    // `configured` stays false: only the picker actually configuring a
    // credential in this process is a post-picker continuation. A pre-existing
    // credential must not route every launch into the setup agent.
    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual(SKIPPED);
    expect(mocks.state.get(GlobalStateKey.ONBOARDING_DECLINED)).toBe(false);
  });

  it('skips onboarding for credential-less users with prior run history', async () => {
    mocks.listExecutions.mockResolvedValue([{ id: 'previous-run' }]);

    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual(SKIPPED);
    expect(mocks.state.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE)).toBe(
      true,
    );
  });

  it.each([
    {
      scenario: 'on a dumb terminal',
      options: { ...INTERACTIVE, termIsDumb: true },
    },
    {
      scenario: 'in headless mode',
      options: { ...INTERACTIVE, mode: 'headless' as const },
    },
  ])('skips $scenario before checking credentials', async ({ options }) => {
    await expect(maybeRunCliOnboarding(options)).resolves.toEqual(SKIPPED);
    expect(mocks.hasCliRunCredential).not.toHaveBeenCalled();
  });
});

// State 1 continuation (docs/prds/2026-06-11-agent-native-onboarding.md): after the gate
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
