// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  clearStoredSession: vi.fn(async () => true),
  getSession: vi.fn(),
  removeStoredSession: vi.fn(async () => true),
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
      removeStoredSession: authMocks.removeStoredSession,
    }),
  },
}));

vi.mock('@frontend/ui/dialogs', () => ({
  confirmModal: async (
    message: string,
    actionLabel: string,
    ...otherLabels: string[]
  ) => {
    const choice = await authMocks.showWarningMessage(
      message,
      { modal: true },
      actionLabel,
      ...otherLabels,
    );
    return choice === actionLabel;
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
import { RELAY_CI_TOKEN_PREFIX, RELAY_TOKEN_ENV_VAR } from '@auth/relayToken';
import { signIn, signOut } from '@commands/auth/authCommands';

function mockUnavailableStoredSession(failure: 'invalid' | 'transient'): void {
  vi.spyOn(SupabaseClient, 'isReady').mockResolvedValue(true);
  vi.spyOn(SupabaseClient, 'getStoredSessionState').mockResolvedValue(failure);
}

describe('auth commands for unavailable stored sessions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('clears an invalid session before opening the sign-in chooser', async () => {
    mockUnavailableStoredSession('invalid');
    const relayAuthentication = vi
      .spyOn(SupabaseClient, 'isAuthenticated')
      .mockResolvedValue(true);
    authMocks.showQuickPick.mockResolvedValue(undefined);

    await expect(signIn()).resolves.toBe(false);

    expect(authMocks.clearStoredSession).toHaveBeenCalledOnce();
    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(authMocks.showQuickPick).toHaveBeenCalledOnce();
    expect(relayAuthentication).not.toHaveBeenCalled();
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

  it('uses a replacement session installed during invalid cleanup', async () => {
    vi.spyOn(SupabaseClient, 'isReady').mockResolvedValue(true);
    vi.spyOn(SupabaseClient, 'getStoredSessionState')
      .mockResolvedValueOnce('invalid')
      .mockResolvedValueOnce('authenticated');
    authMocks.clearStoredSession.mockResolvedValueOnce(false);
    authMocks.getSession.mockResolvedValue({
      id: 'replacement',
      account: { id: 'user-id', label: 'user@example.com' },
    });
    vi.spyOn(SupabaseClient, 'getUser').mockResolvedValue({
      email: 'user@example.com',
    } as never);

    await expect(signIn()).resolves.toBe(true);

    expect(authMocks.clearStoredSession).toHaveBeenCalledOnce();
    expect(authMocks.getSession).toHaveBeenCalledOnce();
    expect(authMocks.showQuickPick).not.toHaveBeenCalled();
    expect(authMocks.showInformationMessage).toHaveBeenCalledWith(
      'Already signed in as user@example.com',
    );
  });

  it('defers sign-in when secondary validation cannot resolve a healthy session', async () => {
    vi.spyOn(SupabaseClient, 'isReady').mockResolvedValue(true);
    vi.spyOn(SupabaseClient, 'getStoredSessionState').mockResolvedValue(
      'authenticated',
    );
    authMocks.getSession.mockResolvedValue(undefined);

    await expect(signIn()).resolves.toBe(false);

    expect(authMocks.clearStoredSession).not.toHaveBeenCalled();
    expect(authMocks.showQuickPick).not.toHaveBeenCalled();
    expect(authMocks.showLoggedMessage).toHaveBeenCalledWith(
      'authCommands',
      expect.stringContaining('temporarily unavailable'),
    );
  });

  it('removes an unavailable stored session without resolving it first', async () => {
    mockUnavailableStoredSession('invalid');
    authMocks.showWarningMessage.mockResolvedValue('Sign out');

    await signOut();

    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(authMocks.removeStoredSession).toHaveBeenCalledOnce();
    expect(authMocks.showInformationMessage).toHaveBeenCalledWith('Signed out');
  });

  it('says a configured relay token keeps authenticating after sign-out', async () => {
    vi.stubEnv(RELAY_TOKEN_ENV_VAR, `${RELAY_CI_TOKEN_PREFIX}ci-token`);
    mockUnavailableStoredSession('invalid');
    authMocks.showWarningMessage.mockResolvedValue('Sign out');

    await signOut();

    expect(authMocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining(RELAY_TOKEN_ENV_VAR),
    );
  });
});
