import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration tests for the maybeRunCliOnboarding gate's early-return branches.
// The gate's final guard is `!process.stdout.isTTY`, which is falsy in the
// vitest runner — so to exercise the credential / declined / dumb-terminal
// branches we stub stdout.isTTY = true and mock the gate's collaborators.

const mocks = vi.hoisted(() => ({
  hasAnyCliCredential: vi.fn(),
  declined: false,
}));

vi.mock('@cli/runtime/credentialStatus', () => ({
  hasAnyCliCredential: mocks.hasAnyCliCredential,
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

const { maybeRunCliOnboarding } = await import('@cli/onboarding/runOnboarding');

const INTERACTIVE = {
  mode: 'interactive' as const,
  stdoutIsTty: true,
  termIsDumb: false,
};

describe('maybeRunCliOnboarding gate', () => {
  let originalIsTty: unknown;

  beforeEach(() => {
    mocks.hasAnyCliCredential.mockReset().mockResolvedValue(false);
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
    mocks.hasAnyCliCredential.mockResolvedValue(true);
    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual({
      configured: false,
      declined: false,
    });
    expect(mocks.hasAnyCliCredential).toHaveBeenCalledOnce();
  });

  it('skips when onboarding was previously declined', async () => {
    mocks.declined = true;
    await expect(maybeRunCliOnboarding(INTERACTIVE)).resolves.toEqual({
      configured: false,
      declined: false,
    });
  });

  it('skips on a dumb terminal before checking credentials', async () => {
    await expect(
      maybeRunCliOnboarding({
        mode: 'interactive',
        stdoutIsTty: true,
        termIsDumb: true,
      }),
    ).resolves.toEqual({ configured: false, declined: false });
    expect(mocks.hasAnyCliCredential).not.toHaveBeenCalled();
  });

  it('skips in headless mode before checking credentials', async () => {
    await expect(
      maybeRunCliOnboarding({
        mode: 'headless',
        stdoutIsTty: true,
        termIsDumb: false,
      }),
    ).resolves.toEqual({ configured: false, declined: false });
    expect(mocks.hasAnyCliCredential).not.toHaveBeenCalled();
  });
});
