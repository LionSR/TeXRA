import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration tests for the maybeRunCliOnboarding gate's early-return branches.
// The gate's final guard is `!process.stdout.isTTY`, which is falsy in the
// vitest runner — so to exercise the credential / declined / dumb-terminal
// branches we stub stdout.isTTY = true and mock the gate's collaborators.

const mocks = vi.hoisted(() => ({
  hasCliCredentialForApiMode: vi.fn(),
  listExecutions: vi.fn(),
  state: new Map<string, unknown>(),
}));

vi.mock('@cli/runtime/credentialStatus', () => ({
  hasCliCredentialForApiMode: mocks.hasCliCredentialForApiMode,
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

describe('maybeRunCliOnboarding gate', () => {
  let originalIsTty: unknown;

  beforeEach(() => {
    mocks.hasCliCredentialForApiMode.mockReset().mockResolvedValue(false);
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
    mocks.hasCliCredentialForApiMode.mockResolvedValue(true);
    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual({
      configured: false,
      declined: false,
    });
    expect(mocks.hasCliCredentialForApiMode).toHaveBeenCalledWith(undefined);
  });

  it('marks prior installs with credentials as first-run done', async () => {
    mocks.state.set(GlobalStateKey.LAST_KNOWN_VERSION, '1.2.3');
    mocks.hasCliCredentialForApiMode.mockResolvedValue(true);

    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual({
      configured: false,
      declined: false,
    });
    expect(mocks.state.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE)).toBe(
      true,
    );
  });

  it('does not treat the API-mode preference as a prior-install signal', async () => {
    // initCliPlatform writes this key during startup, including first launch,
    // so its presence cannot distinguish veterans from fresh installs.
    mocks.state.set('texra.useIncludedModelAccess', true);
    mocks.hasCliCredentialForApiMode.mockResolvedValue(true);

    await maybeRunCliOnboarding(INTERACTIVE);
    expect(mocks.state.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE)).toBe(
      false,
    );
  });

  it('backfills a credentialed fresh install as NOT done (env keys)', async () => {
    // Credential alone proves nothing — fresh installs can inherit env keys.
    mocks.hasCliCredentialForApiMode.mockResolvedValue(true);

    await maybeRunCliOnboarding(INTERACTIVE);
    expect(mocks.state.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE)).toBe(
      false,
    );
  });

  it('checks credentials for the explicitly requested API mode', async () => {
    mocks.hasCliCredentialForApiMode.mockResolvedValue(true);
    await expect(
      maybeRunCliOnboarding({ ...INTERACTIVE, apiMode: 'included' }),
    ).resolves.toEqual({
      configured: false,
      declined: false,
    });
    expect(mocks.hasCliCredentialForApiMode).toHaveBeenCalledWith('included');
  });

  it('skips when onboarding was previously declined', async () => {
    mocks.state.set(GlobalStateKey.ONBOARDING_DECLINED, true);
    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual({
      configured: false,
      declined: false,
    });
    expect(mocks.hasCliCredentialForApiMode).toHaveBeenCalledWith(undefined);
  });

  it('clears a stale declined flag when credentials now exist', async () => {
    mocks.state.set(GlobalStateKey.ONBOARDING_DECLINED, true);
    mocks.state.set(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE, false);
    mocks.hasCliCredentialForApiMode.mockResolvedValue(true);

    // `configured` stays false: only the picker actually configuring a
    // credential in this process is a post-picker continuation. A pre-existing
    // credential must not route every launch into the setup agent.
    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual({
      configured: false,
      declined: false,
    });
    expect(mocks.state.get(GlobalStateKey.ONBOARDING_DECLINED)).toBe(false);
  });

  it('skips onboarding for credential-less users with prior run history', async () => {
    mocks.listExecutions.mockResolvedValue([{ id: 'previous-run' }]);

    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual({
      configured: false,
      declined: false,
    });
    expect(mocks.state.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE)).toBe(
      true,
    );
  });

  it('skips on a dumb terminal before checking credentials', async () => {
    await expect(
      maybeRunCliOnboarding({
        mode: 'interactive',
        stdoutIsTty: true,
        termIsDumb: true,
      }),
    ).resolves.toEqual({ configured: false, declined: false });
    expect(mocks.hasCliCredentialForApiMode).not.toHaveBeenCalled();
  });

  it('skips in headless mode before checking credentials', async () => {
    await expect(
      maybeRunCliOnboarding({
        mode: 'headless',
        stdoutIsTty: true,
        termIsDumb: false,
      }),
    ).resolves.toEqual({ configured: false, declined: false });
    expect(mocks.hasCliCredentialForApiMode).not.toHaveBeenCalled();
  });
});

// State 1 continuation (docs/prds/2026-06-11-agent-native-onboarding.md): after the gate
// configures a credential on a true first run, chat/orchestrate start the
// session with the setup agent instead of the default agent / launcher.
describe('firstRunSetupAgentOverride', () => {
  it('hands the session to the setup agent on a true first run', () => {
    expect(
      firstRunSetupAgentOverride({
        onboardingConfigured: true,
        firstRunDone: false,
      }),
    ).toBe(SETUP_AGENT_NAME);
  });

  it('does nothing when onboarding did not just configure a credential', () => {
    expect(
      firstRunSetupAgentOverride({
        onboardingConfigured: false,
        firstRunDone: false,
      }),
    ).toBeUndefined();
  });

  it('does nothing once the first run is done (backfilled or earned)', () => {
    expect(
      firstRunSetupAgentOverride({
        onboardingConfigured: true,
        firstRunDone: true,
      }),
    ).toBeUndefined();
  });

  it('never displaces an agent the user pinned themselves', () => {
    expect(
      firstRunSetupAgentOverride({
        onboardingConfigured: true,
        firstRunDone: false,
        pinnedAgent: 'research',
      }),
    ).toBeUndefined();
  });

  it('ignores a blank pinned agent', () => {
    expect(
      firstRunSetupAgentOverride({
        onboardingConfigured: true,
        firstRunDone: false,
        pinnedAgent: '   ',
      }),
    ).toBe(SETUP_AGENT_NAME);
  });
});
