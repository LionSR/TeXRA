import { describe, expect, it, vi } from 'vitest';

import { type CodexSessionCoordinator } from '@auth/codex';

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

describe('Codex device login', () => {
  it('does not exchange a token when cancellation follows polling', async () => {
    const controller = new AbortController();
    mocks.requestDeviceUserCode.mockResolvedValue({
      device_auth_id: 'device-auth-id',
      user_code: 'ABCD-EFGH',
      interval: 0,
    });
    mocks.pollDeviceToken.mockImplementation(async () => {
      controller.abort();
      return {
        authorization_code: 'authorization-code',
        code_verifier: 'code-verifier',
      };
    });
    const completeDeviceLogin = vi.fn();
    const coordinator = {
      completeDeviceLogin,
    } as unknown as CodexSessionCoordinator;

    await expect(
      loginWithDeviceCode({
        coordinator,
        onPrompt: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(completeDeviceLogin).not.toHaveBeenCalled();
  });
});
