import {
  OAUTH_PROVIDER_LABELS,
  OAUTH_PROVIDERS,
  type OAuthProvider,
} from '@auth/config';

/**
 * The slice of Electron's `dialog.showMessageBox` this prompt needs. Keeping
 * it structural lets the main process pass the real dialog while the module
 * itself stays free of an Electron runtime import.
 */
type DesktopMessageBox = (options: {
  type: 'question';
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}) => Promise<{ response: number }>;

/**
 * Ask which account to sign in with, offering every {@link OAUTH_PROVIDERS}
 * entry like the extension's sign-in quick pick and the CLI's provider select.
 *
 * The Cancel button sits one past the last provider, so its response index
 * falls off the end of the provider list and resolves to `undefined`; callers
 * treat that as "user declined" and must not start a sign-in.
 */
export async function chooseDesktopOAuthProvider(
  showMessageBox: DesktopMessageBox,
): Promise<OAuthProvider | undefined> {
  const { response } = await showMessageBox({
    type: 'question',
    message: 'Sign in to TeXRA',
    detail: 'Choose the account you want to sign in with.',
    buttons: [
      ...OAUTH_PROVIDERS.map((provider) => OAUTH_PROVIDER_LABELS[provider]),
      'Cancel',
    ],
    defaultId: 0,
    cancelId: OAUTH_PROVIDERS.length,
  });
  return OAUTH_PROVIDERS.at(response);
}
