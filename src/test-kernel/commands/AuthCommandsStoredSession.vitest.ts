// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

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

  it.effect(
    'clears an invalid session before opening the sign-in chooser',
    () =>
      Effect.gen(function* () {
        mockUnavailableStoredSession('invalid');
        const authenticatedProbe = vi
          .spyOn(SupabaseClient, 'isAuthenticated')
          .mockResolvedValue(true);
        authMocks.showQuickPick.mockResolvedValue(undefined);

        expect(yield* signIn).toBe(false);

        expect(authMocks.clearStoredSession).toHaveBeenCalledOnce();
        expect(authMocks.getSession).not.toHaveBeenCalled();
        expect(authMocks.showQuickPick).toHaveBeenCalledOnce();
        expect(authenticatedProbe).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'preserves the session and defers sign-in during a transient outage',
    () =>
      Effect.gen(function* () {
        mockUnavailableStoredSession('transient');

        expect(yield* signIn).toBe(false);

        expect(authMocks.clearStoredSession).not.toHaveBeenCalled();
        expect(authMocks.getSession).not.toHaveBeenCalled();
        expect(authMocks.showQuickPick).not.toHaveBeenCalled();
        expect(authMocks.showLoggedMessage).toHaveBeenCalledWith(
          'authCommands',
          expect.stringContaining('temporarily unavailable'),
        );
      }),
  );

  it.effect('uses a replacement session installed during invalid cleanup', () =>
    Effect.gen(function* () {
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

      expect(yield* signIn).toBe(true);

      expect(authMocks.clearStoredSession).toHaveBeenCalledOnce();
      expect(authMocks.getSession).toHaveBeenCalledOnce();
      expect(authMocks.showQuickPick).not.toHaveBeenCalled();
      expect(authMocks.showInformationMessage).toHaveBeenCalledWith(
        'Already signed in as user@example.com',
      );
    }),
  );

  it.effect(
    'defers sign-in when secondary validation cannot resolve a healthy session',
    () =>
      Effect.gen(function* () {
        vi.spyOn(SupabaseClient, 'isReady').mockResolvedValue(true);
        vi.spyOn(SupabaseClient, 'getStoredSessionState').mockResolvedValue(
          'authenticated',
        );
        authMocks.getSession.mockResolvedValue(undefined);

        expect(yield* signIn).toBe(false);

        expect(authMocks.clearStoredSession).not.toHaveBeenCalled();
        expect(authMocks.showQuickPick).not.toHaveBeenCalled();
        expect(authMocks.showLoggedMessage).toHaveBeenCalledWith(
          'authCommands',
          expect.stringContaining('temporarily unavailable'),
        );
      }),
  );

  it.effect(
    'removes an unavailable stored session without resolving it first',
    () =>
      Effect.gen(function* () {
        mockUnavailableStoredSession('invalid');
        authMocks.showWarningMessage.mockResolvedValue('Sign out');

        yield* signOut;

        expect(authMocks.getSession).not.toHaveBeenCalled();
        expect(authMocks.removeStoredSession).toHaveBeenCalledOnce();
        expect(authMocks.showInformationMessage).toHaveBeenCalledWith(
          'Signed out',
        );
      }),
  );
});
