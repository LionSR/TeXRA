// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  clearStoredSession: vi.fn(async () => true),
  getSession: vi.fn(),
  showInformationMessage: vi.fn(),
  showLoggedMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  authentication: {
    getSession: authMocks.getSession,
  },
  env: {
    openExternal: vi.fn(),
  },
  Uri: {
    parse: (value: string) => value,
  },
  window: {
    showInformationMessage: authMocks.showInformationMessage,
    showInputBox: vi.fn(),
    showQuickPick: authMocks.showQuickPick,
    showWarningMessage: authMocks.showWarningMessage,
  },
}));

vi.mock('@frontend/auth/SupabaseAuthProvider', () => ({
  SupabaseAuthProvider: {
    getInstance: () => ({
      clearStoredSession: authMocks.clearStoredSession,
    }),
  },
}));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedErrorMessage: vi.fn(),
  showLoggedMessage: authMocks.showLoggedMessage,
}));

vi.mock('@utils/config/configUtils', () => ({
  getConfig: () => false,
}));

// Local imports
import { SupabaseClient } from '@auth/SupabaseClient';
import { signIn, signOut } from '@commands/auth/authCommands';

function mockUnavailableStoredSession(failure: 'invalid' | 'transient'): void {
  vi.spyOn(SupabaseClient, 'isReady').mockResolvedValue(true);
  vi.spyOn(SupabaseClient, 'hasStoredSession').mockResolvedValue(true);
  vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(false);
  vi.spyOn(SupabaseClient, 'getLastSessionRefreshFailure').mockReturnValue(
    failure,
  );
}

describe('auth commands for unavailable stored sessions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('clears an invalid session before opening the sign-in chooser', async () => {
    mockUnavailableStoredSession('invalid');
    authMocks.showQuickPick.mockResolvedValue(undefined);

    await expect(signIn()).resolves.toBe(false);

    expect(authMocks.clearStoredSession).toHaveBeenCalledOnce();
    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(authMocks.showQuickPick).toHaveBeenCalledOnce();
  });

  it('preserves the session and defers sign-in during a transient outage', async () => {
    mockUnavailableStoredSession('transient');

    await expect(signIn()).resolves.toBe(false);

    expect(authMocks.clearStoredSession).not.toHaveBeenCalled();
    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(authMocks.showQuickPick).not.toHaveBeenCalled();
    expect(authMocks.showLoggedMessage).toHaveBeenCalledWith(
      'authCommands',
      expect.stringContaining('temporarily unavailable'),
    );
  });

  it('clears an unavailable stored session without resolving it first', async () => {
    mockUnavailableStoredSession('invalid');
    authMocks.showWarningMessage.mockResolvedValue('Clear Session');

    await signOut();

    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(authMocks.clearStoredSession).toHaveBeenCalledOnce();
    expect(authMocks.showInformationMessage).toHaveBeenCalledWith(
      'Stored session cleared',
    );
  });
});
