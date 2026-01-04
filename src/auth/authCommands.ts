import * as vscode from 'vscode';
import { ProfileViewProvider } from '@profileView/ProfileViewProvider';
import { SupabaseClient } from './SupabaseClient';
import { SupabaseAuthProvider } from './SupabaseAuthProvider';
import {
  OAUTH_PROVIDERS,
  OAUTH_PROVIDER_LABELS,
  type OAuthProvider,
  getExternalAuthCallbackUri,
} from './config';

/**
 * Command identifiers for auth-related commands.
 */
export const AUTH_COMMANDS = {
  SIGN_IN: 'texra.auth.signIn',
  SIGN_OUT: 'texra.auth.signOut',
  VIEW_PROFILE: 'texra.auth.viewProfile',
  ACCOUNT_MENU: 'texra.auth.accountMenu',
} as const;

// Singleton instance of ProfileViewProvider
let profileViewProvider: ProfileViewProvider | null = null;

/**
 * Initialize the profile view provider.
 * Must be called during extension activation.
 */
export function initializeProfileViewProvider(
  context: vscode.ExtensionContext,
): ProfileViewProvider {
  if (!profileViewProvider) {
    profileViewProvider = new ProfileViewProvider(context);
  }
  return profileViewProvider;
}

/** Auth method type including OAuth providers, browser variants, and email */
type AuthMethod = OAuthProvider | 'github-browser' | 'email';

/** Email login is disabled due to remote configuration issues */
const EMAIL_LOGIN_ENABLED = false;

/** All sign-in options shown to users */
interface SignInOption {
  label: string;
  description: string;
  method: AuthMethod;
}

/**
 * Command to sign in to TeXRA account.
 */
export async function signIn(): Promise<void> {
  try {
    // Check if already signed in
    const existing = await vscode.authentication.getSession(
      'texra-supabase',
      [],
      {
        silent: true,
      },
    );

    if (existing) {
      const user = await SupabaseClient.getUser();
      void vscode.window.showInformationMessage(
        `Already signed in as ${user?.email || 'unknown user'}`,
      );
      return;
    }

    // Check if VS Code's native GitHub auth is available (user already logged in to GitHub in VS Code)
    const hasNativeGitHubAuth = await vscode.authentication
      .getSession('github', ['user:email'], { silent: true })
      .then((session) => session !== undefined)
      .catch(() => false);

    // Build sign-in options from enabled auth methods
    // Browser-based OAuth options first (Google, then GitHub), native GitHub option at the bottom if available
    const signInOptions: SignInOption[] = [
      {
        label: '$(globe) Google',
        description: 'Sign in with Google',
        method: 'google' as AuthMethod,
      },
      {
        label: '$(github) GitHub',
        description: 'Sign in with GitHub via web browser',
        method: 'github-browser' as AuthMethod,
      },
      ...(EMAIL_LOGIN_ENABLED
        ? [
            {
              label: '$(mail) Email',
              description: 'Sign in with a magic link sent to your email',
              method: 'email' as AuthMethod,
            },
          ]
        : []),
      // Native GitHub auth only shown if user has working VS Code GitHub authentication
      ...(hasNativeGitHubAuth
        ? [
            {
              label: '$(github) GitHub (Native)',
              description: 'Sign in using VS Code GitHub authentication',
              method: 'github' as AuthMethod,
            },
          ]
        : []),
    ];

    const selected = await vscode.window.showQuickPick(signInOptions, {
      placeHolder: 'Choose a sign-in method',
      title: 'TeXRA Sign In',
    });

    if (!selected) {
      return; // User cancelled
    }

    // Handle email authentication separately
    if (selected.method === 'email') {
      await signInWithEmail();
      return;
    }

    // Request OAuth authentication with selected provider passed via scopes
    const session = await vscode.authentication.getSession(
      'texra-supabase',
      [`provider:${selected.method}`],
      {
        createIfNone: true,
      },
    );

    if (session) {
      const user = await SupabaseClient.getUser();
      const tier = await SupabaseClient.getUserTier();
      void vscode.window.showInformationMessage(
        `Signed in as ${user?.email || 'unknown user'} (${tier} tier)`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Sign in failed: ${message}`);
  }
}

/**
 * Sign in using email magic link.
 * Sends a one-time login link to the user's email.
 * Uses vscode.env.asExternalUri() to get environment-appropriate callback URI.
 */
async function signInWithEmail(): Promise<void> {
  // Prompt for email
  const email = await vscode.window.showInputBox({
    prompt: 'Enter your email address',
    placeHolder: 'you@example.com',
    validateInput: (value) => {
      if (!value) {
        return 'Email is required';
      }
      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        return 'Please enter a valid email address';
      }
      return undefined;
    },
  });

  if (!email) {
    return; // User cancelled
  }

  try {
    const supabase = SupabaseClient.getClient();

    // Get environment-appropriate callback URI (handles Codespaces, Remote SSH, etc.)
    const redirectUri = await getExternalAuthCallbackUri();

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectUri,
      },
    });

    if (error) {
      throw new Error(error.message);
    }

    void vscode.window.showInformationMessage(
      `Magic link sent to ${email}. Click the link in your email - VS Code will sign you in automatically.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to send magic link: ${message}`,
    );
  }
}

/**
 * Command to sign out of TeXRA account.
 */
export async function signOut(): Promise<void> {
  try {
    const session = await vscode.authentication.getSession(
      'texra-supabase',
      [],
      {
        silent: true,
      },
    );

    if (!session) {
      void vscode.window.showInformationMessage('Not signed in');
      return;
    }

    // Confirm sign out
    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to sign out?',
      { modal: true },
      'Sign Out',
    );

    if (confirm !== 'Sign Out') {
      return;
    }

    // Use authentication provider to properly sign out
    const authProvider = SupabaseAuthProvider.getInstance();
    if (authProvider) {
      // removeSession() handles cache clearing internally
      await authProvider.removeSession(session.id);
      void vscode.window.showInformationMessage('Signed out successfully');
    } else {
      void vscode.window.showErrorMessage(
        'Authentication provider not available',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Sign out failed: ${message}`);
  }
}

/**
 * Command to view profile and account status.
 * Uses the ProfileViewProvider for consistent webview architecture.
 */
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
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to load profile: ${message}`);
  }
}

/**
 * Command to check authentication status (for status bar, etc.).
 */
export async function getAuthStatus(): Promise<{
  authenticated: boolean;
  email?: string;
  tier?: string;
}> {
  const isAuth = await SupabaseClient.isAuthenticated();
  if (!isAuth) {
    return { authenticated: false };
  }

  const user = await SupabaseClient.getUser();
  const tier = await SupabaseClient.getUserTier();

  return {
    authenticated: true,
    email: user?.email,
    tier,
  };
}

/**
 * Command to show account menu with sign in/out and profile options.
 * Provides accessible UI for authentication actions.
 */
export async function showAccountMenu(): Promise<void> {
  try {
    const status = await getAuthStatus();

    if (!status.authenticated) {
      // Not signed in - show sign in option
      const items = [
        {
          label: '$(sign-in) Sign In',
          description:
            'Access AI models and remote agents via Researcher Access Program',
          action: 'signIn' as const,
        },
      ];

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Account Options',
      });

      if (choice?.action === 'signIn') {
        await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
      }
    } else {
      // Signed in - show profile and sign out options
      const items = [
        {
          label: '$(account) View Profile',
          description: `Signed in as ${status.email || 'unknown'} (${status.tier} tier)`,
          action: 'viewProfile' as const,
        },
        {
          label: '$(sign-out) Sign Out',
          description: 'Sign out of your TeXRA account',
          action: 'signOut' as const,
        },
      ];

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Account Options',
      });

      if (choice) {
        switch (choice.action) {
          case 'viewProfile':
            await vscode.commands.executeCommand(AUTH_COMMANDS.VIEW_PROFILE);
            break;
          case 'signOut':
            await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_OUT);
            break;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to show account menu: ${message}`,
    );
  }
}
