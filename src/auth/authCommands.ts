import * as vscode from 'vscode';
import { ProfileViewProvider } from '@profileView/ProfileViewProvider';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { getScopedConfig } from '@utils/config';
import { SupabaseClient } from './SupabaseClient';
import { SupabaseAuthProvider } from './SupabaseAuthProvider';
import { type OAuthProvider, getExternalAuthCallbackUri } from './config';

const AUTH_PROVIDER_ID = 'texra-supabase';

export const AUTH_COMMANDS = {
  SIGN_IN: 'texra.auth.signIn',
  SIGN_OUT: 'texra.auth.signOut',
  VIEW_PROFILE: 'texra.auth.viewProfile',
  ACCOUNT_MENU: 'texra.auth.accountMenu',
} as const;

let profileViewProvider: ProfileViewProvider | null = null;

export function initializeProfileViewProvider(
  context: vscode.ExtensionContext,
): ProfileViewProvider {
  if (!profileViewProvider) {
    profileViewProvider = new ProfileViewProvider(context);
  }
  return profileViewProvider;
}

type AuthMethod = OAuthProvider | 'github-browser' | 'email';

const EMAIL_LOGIN_ENABLED = false;

function isVSCodeGitHubEnabled(): boolean {
  return getScopedConfig('texra.auth', 'enableVSCodeGitHub', false);
}

async function getExistingSession(): Promise<
  vscode.AuthenticationSession | undefined
> {
  return vscode.authentication.getSession(AUTH_PROVIDER_ID, [], {
    silent: true,
  });
}

interface SignInOption {
  label: string;
  description: string;
  method: AuthMethod;
}

function getSignInOptions(): SignInOption[] {
  const options: SignInOption[] = [
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

  if (EMAIL_LOGIN_ENABLED) {
    options.push({
      label: '$(mail) Email',
      description: 'Sign in with a magic link sent to your email',
      method: 'email',
    });
  }

  if (isVSCodeGitHubEnabled()) {
    options.push({
      label: '$(github) GitHub (VS Code)',
      description: 'Sign in using VS Code GitHub authentication',
      method: 'github',
    });
  }

  return options;
}

export async function signIn(): Promise<void> {
  try {
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
  if (!profileViewProvider) {
    void vscode.window.showErrorMessage(
      'Profile view not initialized. Please reload the extension.',
    );
    return;
  }

  try {
    await profileViewProvider.showProfileView();
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

interface MenuOption {
  label: string;
  description: string;
  command: string;
}

export async function showAccountMenu(): Promise<void> {
  try {
    const status = await getAuthStatus();

    const items: MenuOption[] = status.authenticated
      ? [
          {
            label: '$(account) View Profile',
            description: `Signed in as ${status.email || 'unknown'} (${status.tier} tier)`,
            command: AUTH_COMMANDS.VIEW_PROFILE,
          },
          {
            label: '$(sign-out) Sign Out',
            description: 'Sign out of your TeXRA account',
            command: AUTH_COMMANDS.SIGN_OUT,
          },
        ]
      : [
          {
            label: '$(sign-in) Sign In',
            description:
              'Access AI models and remote agents via Researcher Access Program',
            command: AUTH_COMMANDS.SIGN_IN,
          },
        ];

    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: 'Account Options',
    });
    if (choice) {
      await vscode.commands.executeCommand(choice.command);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Failed to show account menu: ${toErrorMessage(error)}`,
    );
  }
}
