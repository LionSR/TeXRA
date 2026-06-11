import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration tests for the maybeRunCliOnboarding gate's early-return branches.
// The gate's final guard is `!process.stdout.isTTY`, which is falsy in the
// vitest runner — so to exercise the credential / declined / dumb-terminal
// branches we stub stdout.isTTY = true and mock the gate's collaborators.

const mocks = vi.hoisted(() => ({
  hasCliCredentialForApiMode: vi.fn(),
  declined: false,
}));

vi.mock('@cli/runtime/credentialStatus', () => ({
  hasCliCredentialForApiMode: mocks.hasCliCredentialForApiMode,
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({
    globalState: {
      get: (_key: string, defaultValue?: unknown) =>
        mocks.declined ? true : defaultValue,
      update: async () => {},
    },
  }),
}));

import {
  firstRunSetupAgentOverride,
  SETUP_AGENT_NAME,
} from '@cli/onboarding/setupContinuation';

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
    mocks.declined = false;
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
    mocks.declined = true;
    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual({
      configured: false,
      declined: false,
    });
    expect(mocks.hasCliCredentialForApiMode).not.toHaveBeenCalled();
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

// State 1 continuation (docs/prd/agent-native-onboarding.md): after the gate
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
