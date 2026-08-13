import { describe, expect, it, vi } from 'vitest';

import { CodexAuthError, type CodexSessionCoordinator } from '@auth/codex';

const mocks = vi.hoisted(() => ({
  pollDeviceToken: vi.fn(),
  requestDeviceUserCode: vi.fn(),
}));

vi.mock('@auth/codex/codexOAuthClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auth/codex/codexOAuthClient')>()),
  pollDeviceToken: mocks.pollDeviceToken,
  requestDeviceUserCode: mocks.requestDeviceUserCode,
}));

const { loginWithDeviceCode } = await import('@auth/codex/codexDeviceLogin');

function stubDeviceUserCode(overrides: Record<string, unknown> = {}): void {
  mocks.requestDeviceUserCode.mockResolvedValue({
    device_auth_id: 'device-auth-id',
    user_code: 'ABCD-EFGH',
    interval: 0,
    ...overrides,
  });
}

function coordinatorStub(): CodexSessionCoordinator {
  return { completeDeviceLogin: vi.fn() } as unknown as CodexSessionCoordinator;
}

describe('Codex device login', () => {
  it('does not exchange a token when cancellation follows polling', async () => {
    const controller = new AbortController();
    stubDeviceUserCode();
    mocks.pollDeviceToken.mockImplementation(async () => {
      controller.abort();
      return {
        authorization_code: 'authorization-code',
        code_verifier: 'code-verifier',
      };
    });
    const coordinator = coordinatorStub();

    await expect(
      loginWithDeviceCode({
        coordinator,
        onPrompt: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(coordinator.completeDeviceLogin).not.toHaveBeenCalled();
  });

  it('gives up at the expiry the server reported, not the local fallback', async () => {
    stubDeviceUserCode({
      interval: 0.01,
      // 1 ms: already elapsed by the time the first poll returns.
      expires_in: 0.001,
    });
    let polls = 0;
    mocks.pollDeviceToken.mockImplementation(async () => {
      polls += 1;
      if (polls > 3) throw new Error('polled past the reported expiry');
      throw new CodexAuthError('authorization_pending', 'pending');
    });

    await expect(
      loginWithDeviceCode({
        coordinator: coordinatorStub(),
        onPrompt: vi.fn(),
      }),
    ).rejects.toThrow('Device-code sign-in timed out.');

    expect(polls).toBe(1);
  });
});
