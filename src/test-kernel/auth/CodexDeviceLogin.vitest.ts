import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CodexSessionCoordinator } from '@auth/codex/CodexSessionCoordinator';
import { loginWithDeviceCode } from '@auth/codex/codexDeviceLogin';
import {
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_USERCODE_URL,
} from '@auth/codex/codexConstants';
import { jsonResponse } from '@test/support/fetchTestUtils';

/**
 * Drive the flow through the wire: the usercode endpoint answers once, and
 * every token poll goes to `onPoll`.
 */
function stubDeviceEndpoints(
  userCode: Record<string, unknown>,
  onPoll: (init: RequestInit | undefined) => Response,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === CODEX_DEVICE_USERCODE_URL) {
        return jsonResponse({
          device_auth_id: 'device-auth-id',
          user_code: 'ABCD-EFGH',
          interval: 0.001,
          ...userCode,
        });
      }
      if (url === CODEX_DEVICE_TOKEN_URL) return onPoll(init);
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

function coordinatorStub(): CodexSessionCoordinator {
  return { completeDeviceLogin: vi.fn() } as unknown as CodexSessionCoordinator;
}

describe('Codex device login', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not exchange a token when cancellation follows polling', async () => {
    const controller = new AbortController();
    stubDeviceEndpoints({}, () => {
      controller.abort();
      return jsonResponse({
        authorization_code: 'authorization-code',
        code_verifier: 'code-verifier',
      });
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

  it('resolves with the session when cancellation lands while it is stored', async () => {
    const controller = new AbortController();
    stubDeviceEndpoints({}, () =>
      jsonResponse({
        authorization_code: 'authorization-code',
        code_verifier: 'code-verifier',
      }),
    );
    const coordinator = coordinatorStub();
    vi.mocked(coordinator.completeDeviceLogin).mockImplementation(async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { accessToken: 'stored' } as never;
    });

    await expect(
      loginWithDeviceCode({
        coordinator,
        onPrompt: vi.fn(),
        signal: controller.signal,
      }),
    ).resolves.toEqual({ accessToken: 'stored' });
  });

  it('gives up at the expiry the server reported, not the local fallback', async () => {
    // 20 ms of polling at 1 ms; the 15-minute fallback would hang the test.
    let polls = 0;
    stubDeviceEndpoints({ expires_in: 0.02 }, () => {
      polls += 1;
      return jsonResponse({ error: 'authorization_pending' }, 403);
    });

    await expect(
      loginWithDeviceCode({
        coordinator: coordinatorStub(),
        onPrompt: vi.fn(),
      }),
    ).rejects.toThrow('Device-code sign-in timed out.');

    expect(polls).toBeGreaterThanOrEqual(1);
  });
});
