import * as vscode from 'vscode';
import { SupabaseClient } from '@auth/SupabaseClient';
import { type OAuthProvider } from '@auth/config';
import { AUTH_PROVIDER_ID } from '@auth/constants';
import { relayTokenSignOutNotice } from '@auth/relayToken';
import type { MainViewAuthStatus } from '@controllers/mainView/MainViewTypes';
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';

const CHANNEL = 'authCommands';

type AuthMethod = OAuthProvider | 'github-browser';

async function getExistingSession(
  authReady?: boolean,
): Promise<vscode.AuthenticationSession | undefined> {
  // Skip VS Code auth API if auth system not ready to avoid timeout
  if (!(authReady ?? (await SupabaseClient.isReady()))) {
    return undefined;
  }
  return vscode.authentication.getSession(AUTH_PROVIDER_ID, [], {
    silent: true,
  });
}

interface SignInOption {
  label: string;
  description: string;
  method: AuthMethod;
}

const SIGN_IN_OPTIONS: readonly SignInOption[] = [
  {
    label: '$(globe) Google',
    description: 'Sign in with Google',
    method: 'google',
  },
  {
    label: '$(github) GitHub',
    description: 'Sign in with GitHub via web browser',
    method: 'github-browser',
  },
];

// "<prefix> <email>" info toast; the tier suffix is only fetched and
// appended when `includeTier` is set.
async function showSignedInMessage(
  prefix: string,
  includeTier: boolean,
): Promise<void> {
  const user = await SupabaseClient.getUser();
  const email = user?.email || 'unknown user';
  const tierSuffix = includeTier
    ? ` (${await SupabaseClient.getUserTier()} tier)`
    : '';
  void vscode.window.showInformationMessage(`${prefix} ${email}${tierSuffix}`);
}

/**
 * Run the interactive sign-in flow.
 *
 * Returns `true` when the user is authenticated by the time this resolves
 * (already signed in, or completed an OAuth flow). Returns `false` when the
 * user cancelled or hit an error.
 */
export async function signIn(): Promise<boolean> {
  try {
    // Check if auth system is ready - if not, provide clear error with reason
    const authReady = await SupabaseClient.isReady();
    if (!authReady) {
      const initError = SupabaseClient.getInitError();
      const reason = initError
        ? initError.message
        : 'Authentication service not initialized';
      void showLoggedMessage(
        CHANNEL,
        `Sign in failed: ${reason}. Try reloading VS Code (Ctrl+Shift+P → "Reload Window"). If the problem continues, open Help → Toggle Developer Tools → Console for details.`,
      );
      return false;
    }

    const showAuthServiceUnavailable = () =>
      showLoggedMessage(
        CHANNEL,
        'The authentication service is temporarily unavailable. Your stored session has not been removed; try again later.',
      );

    let storedSessionState = await SupabaseClient.getStoredSessionState();
    if (storedSessionState === 'invalid') {
      const cleared =
        (await SupabaseAuthProvider.getInstance()?.clearStoredSession()) ??
        false;
      storedSessionState = cleared
        ? 'none'
        : await SupabaseClient.getStoredSessionState();
    }
    if (storedSessionState === 'transient') {
      void showAuthServiceUnavailable();
      return false;
    }

    if (storedSessionState === 'authenticated') {
      const existing = await getExistingSession(authReady);
      if (existing) {
        await showSignedInMessage('Already signed in as', false);
        return true;
      }
      void showAuthServiceUnavailable();
      return false;
    }

    const selected = await vscode.window.showQuickPick<SignInOption>(
      [...SIGN_IN_OPTIONS],
      {
        title: 'TeXRA Sign In',
        placeHolder: 'Choose a sign-in method',
        prompt:
          'Sign in to access AI models, remote agents, and TeXRA Researcher features',
      },
    );
    if (!selected) return false;

    const session = await vscode.authentication.getSession(
      AUTH_PROVIDER_ID,
      [`provider:${selected.method}`],
      { createIfNone: true },
    );

    if (session) {
      await showSignedInMessage('Signed in as', true);
      return true;
    }
    return false;
  } catch (error) {
    void showLoggedErrorMessage(CHANNEL, 'Sign in failed', error);
    return false;
  }
}

export async function signOut(): Promise<void> {
  try {
    const storedSessionState = await SupabaseClient.getStoredSessionState();
    if (storedSessionState === 'none') {
      // A configured relay token authenticates without a stored session, so
      // "Not signed in" alone would contradict the access the user still has.
      const notice = relayTokenSignOutNotice();
      void vscode.window.showInformationMessage(
        notice ? `Not signed in. ${notice}` : 'Not signed in',
      );
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to sign out?',
      { modal: true },
      'Sign Out',
    );
    if (confirm !== 'Sign Out') return;

    const authProvider = SupabaseAuthProvider.getInstance();
    if (authProvider) {
      const removed = await authProvider.removeStoredSession();
      const outcome = removed
        ? 'Signed out successfully'
        : 'No stored session found';
      const relayNotice = relayTokenSignOutNotice();
      void vscode.window.showInformationMessage(
        relayNotice ? `${outcome}. ${relayNotice}` : outcome,
      );
    } else {
      void showLoggedMessage(CHANNEL, 'Authentication provider not available');
    }
  } catch (error) {
    void showLoggedErrorMessage(CHANNEL, 'Sign out failed', error);
  }
}

/**
 * Login-banner input for the main view. Only the authenticated flag is
 * consumed, so this deliberately avoids the profile and tier round-trips that
 * the settings-view profile message makes.
 */
export async function getAuthStatus(): Promise<MainViewAuthStatus> {
  return { authenticated: await SupabaseClient.isAuthenticated() };
}
