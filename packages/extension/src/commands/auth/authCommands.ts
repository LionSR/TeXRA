import * as vscode from 'vscode';
import { z } from 'zod';
import { SupabaseClient } from '@auth/SupabaseClient';
import { type OAuthProvider, getExternalAuthCallbackUri } from '@auth/config';
import { AUTH_PROVIDER_ID } from '@auth/constants';
import { showSettingsView } from '@commands/settings';
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';

const CHANNEL = 'authCommands';
logger.initialize(CHANNEL);

type AuthMethod = OAuthProvider | 'github-browser' | 'email';

const EMAIL_LOGIN_ENABLED = false;

function isVSCodeGitHubEnabled(): boolean {
  return getConfig('auth.enableVSCodeGitHub', false);
}

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

/** All possible sign-in options - filtered at runtime based on feature flags. */
const ALL_SIGN_IN_OPTIONS: readonly SignInOption[] = [
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
  {
    label: '$(mail) Email',
    description: 'Sign in with a magic link sent to your email',
    method: 'email',
  },
  {
    label: '$(github) GitHub (VS Code)',
    description: 'Sign in using VS Code GitHub authentication',
    method: 'github',
  },
];

function getSignInOptions(): SignInOption[] {
  return ALL_SIGN_IN_OPTIONS.filter((option) => {
    if (option.method === 'email') return EMAIL_LOGIN_ENABLED;
    if (option.method === 'github') return isVSCodeGitHubEnabled();
    return true;
  });
}

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
 * (already signed in, or completed an OAuth flow). Returns `false` when
 * the user cancelled, hit an error, or chose email sign-in (which
 * completes asynchronously after the user clicks the OTP link).
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

    const existing = await getExistingSession(authReady);
    if (existing) {
      await showSignedInMessage('Already signed in as', false);
      return true;
    }

    const selected = await vscode.window.showQuickPick<SignInOption>(
      getSignInOptions(),
      {
        title: 'TeXRA Sign In',
        placeHolder: 'Choose a sign-in method',
        prompt:
          'Sign in to access AI models, remote agents, and TeXRA Researcher features',
      },
    );
    if (!selected) return false;

    if (selected.method === 'email') {
      await signInWithEmail();
      return false;
    }

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

async function signInWithEmail(): Promise<void> {
  const email = await vscode.window.showInputBox({
    prompt: 'Enter your email address',
    placeHolder: 'you@example.com',
    validateInput: (value) => {
      if (!value) return 'Email is required';
      if (!z.email().safeParse(value).success) {
        return 'Please enter a valid email address';
      }
      return undefined;
    },
  });
  if (!email) return;

  try {
    // Use the implicit-flow client so the magic link carries tokens directly
    // (not a PKCE code), which completes wherever the email is opened.
    const supabase = SupabaseClient.getOtpClient();
    const redirectUri = await getExternalAuthCallbackUri();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectUri },
    });

    if (error) throw new Error(error.message);

    void vscode.window.showInformationMessage(
      `Magic link sent to ${email}. Click the link in your email - VS Code will sign you in automatically.`,
    );
  } catch (error) {
    void showLoggedErrorMessage(CHANNEL, 'Failed to send magic link', error);
  }
}

export async function signOut(): Promise<void> {
  try {
    const session = await getExistingSession();
    if (!session) {
      void vscode.window.showInformationMessage('Not signed in');
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
      await authProvider.removeSession(session.id);
      void vscode.window.showInformationMessage('Signed out successfully');
    } else {
      void showLoggedMessage(CHANNEL, 'Authentication provider not available');
    }
  } catch (error) {
    void showLoggedErrorMessage(CHANNEL, 'Sign out failed', error);
  }
}

export async function viewProfile(): Promise<void> {
  try {
    await showSettingsView();
  } catch (error) {
    void showLoggedErrorMessage(CHANNEL, 'Failed to load profile', error);
  }
}

export async function getAuthStatus(): Promise<{
  authenticated: boolean;
  email?: string;
  tier?: string;
}> {
  const isAuth = await SupabaseClient.isAuthenticated();
  if (!isAuth) return { authenticated: false };

  const user = await SupabaseClient.getUser();
  const tier = await SupabaseClient.getUserTier();
  return { authenticated: true, email: user?.email, tier };
}
