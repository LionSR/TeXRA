import * as vscode from 'vscode';
import { SupabaseClient } from '@auth/SupabaseClient';
import { type OAuthProvider } from '@auth/config';
import { AUTH_PROVIDER_ID } from '@auth/constants';
import type { MainViewAuthStatus } from '@controllers/mainView/MainViewStartupController';
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';
import { confirmModal } from '@frontend/ui/dialogs';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';

const CHANNEL = 'authCommands';

type AuthMethod = OAuthProvider | 'github-browser';

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

// "<prefix> <email>" info toast.
async function showSignedInMessage(prefix: string): Promise<void> {
  const user = await SupabaseClient.getUser();
  const email = user?.email || 'unknown user';
  void vscode.window.showInformationMessage(`${prefix} ${email}`);
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
      // Auth readiness was established above, so the VS Code auth API is safe
      // to consult here (calling it before readiness can hang on a timeout).
      const existing = await vscode.authentication.getSession(
        AUTH_PROVIDER_ID,
        [],
        { silent: true },
      );
      if (existing) {
        await showSignedInMessage('Already signed in as');
        return true;
      }
      void showAuthServiceUnavailable();
      return false;
    }

    // Each option names its own provider, so a second "sign in to…" line
    // would only repeat the title.
    const selected = await vscode.window.showQuickPick<SignInOption>(
      SIGN_IN_OPTIONS,
      { title: 'Sign in to TeXRA', placeHolder: 'Choose a sign-in method' },
    );
    if (!selected) return false;

    const session = await vscode.authentication.getSession(
      AUTH_PROVIDER_ID,
      [`provider:${selected.method}`],
      { createIfNone: true },
    );

    if (session) {
      await showSignedInMessage('Signed in as');
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
      void vscode.window.showInformationMessage('Not signed in');
      return;
    }

    const confirmed = await confirmModal(
      'Are you sure you want to sign out?',
      'Sign out',
    );
    if (!confirmed) return;

    const authProvider = SupabaseAuthProvider.getInstance();
    if (authProvider) {
      const removed = await authProvider.removeStoredSession();
      const outcome = removed ? 'Signed out' : 'You were already signed out';
      void vscode.window.showInformationMessage(outcome);
    } else {
      void showLoggedMessage(
        CHANNEL,
        'Sign-out is unavailable right now. Reload the window, then try again.',
      );
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
