import * as vscode from 'vscode';

import { AUTH_PROVIDER_ID } from '@auth/constants';

/**
 * Subscribe to VS Code auth-session changes for the TeXRA Supabase provider,
 * filtering out other extensions' providers. Single home for the provider-id
 * check that the status bar, main view, and settings view all need.
 */
export function onTexraAuthSessionsChanged(
  context: vscode.ExtensionContext,
  listener: () => void,
): void {
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === AUTH_PROVIDER_ID) {
        listener();
      }
    }),
  );
}
