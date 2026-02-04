import * as vscode from 'vscode';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { getConfig } from '@utils/config';
import { SupabaseClient } from './SupabaseClient';
import { SupabaseAuthProvider } from './SupabaseAuthProvider';
import { type OAuthProvider, getExternalAuthCallbackUri } from './config';

const AUTH_PROVIDER_ID = 'texra-supabase';

export const AUTH_COMMANDS = {
  SIGN_IN: 'texra.auth.signIn',
  SIGN_OUT: 'texra.auth.signOut',
  VIEW_PROFILE: 'texra.auth.viewProfile',
} as const;

type AuthMethod = OAuthProvider | 'github-browser' | 'email';

const EMAIL_LOGIN_ENABLED = false;

function isVSCodeGitHubEnabled(): boolean {
  return getConfig('auth.enableVSCodeGitHub', false);
}

async function getExistingSession(): Promise<
  vscode.AuthenticationSession | undefined
> {
  // Skip VS Code auth API if auth system not ready to avoid timeout
  if (!SupabaseClient.isReady()) {
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

export async function signIn(): Promise<void> {
  try {
    // Check if auth system is ready - if not, provide clear error with reason
    if (!SupabaseClient.isReady()) {
      const initError = SupabaseClient.getInitError();
      const reason = initError
        ? initError.message
        : 'Authentication service not initialized';
      void vscode.window.showErrorMessage(
        `Sign in failed: ${reason}. Please reload VS Code and try again. If the issue persists, check the TeXRA output channel for errors.`,
      );
      return;
    }

    const existing = await getExistingSession();
    if (existing) {
      const user = await SupabaseClient.getUser();
      void vscode.window.showInformationMessage(
        `Already signed in as ${user?.email || 'unknown user'}`,
      );
      return;
    }

    const selected = await vscode.window.showQuickPick(getSignInOptions(), {
      placeHolder: 'Choose a sign-in method',
      title: 'TeXRA Sign In',
    });
    if (!selected) return;

    if (selected.method === 'email') {
      await signInWithEmail();
      return;
    }

    const session = await vscode.authentication.getSession(
      AUTH_PROVIDER_ID,
      [`provider:${selected.method}`],
      { createIfNone: true },
    );

    if (session) {
      const user = await SupabaseClient.getUser();
      const tier = await SupabaseClient.getUserTier();
      void vscode.window.showInformationMessage(
        `Signed in as ${user?.email || 'unknown user'} (${tier} tier)`,
      );
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Sign in failed: ${toErrorMessage(error)}`,
    );
  }
}

async function signInWithEmail(): Promise<void> {
  const email = await vscode.window.showInputBox({
    prompt: 'Enter your email address',
    placeHolder: 'you@example.com',
    validateInput: (value) => {
      if (!value) return 'Email is required';
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) return 'Please enter a valid email address';
      return undefined;
    },
  });
  if (!email) return;

  try {
    const supabase = SupabaseClient.getClient();
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
    void vscode.window.showErrorMessage(
      `Failed to send magic link: ${toErrorMessage(error)}`,
    );
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
      void vscode.window.showErrorMessage(
        'Authentication provider not available',
      );
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Sign out failed: ${toErrorMessage(error)}`,
    );
  }
}

export async function viewProfile(): Promise<void> {
  try {
    // Import dynamically to avoid circular dependencies
    const { showSettingsView } = await import('@commands/settings');
    await showSettingsView();
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Failed to load profile: ${toErrorMessage(error)}`,
    );
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
