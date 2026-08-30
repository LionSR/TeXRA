/**
 * Shared context for domain-specific settings handler delegates.
 *
 * Provides the minimal surface that handler implementations need
 * from the main SettingsViewMessageHandler.
 */
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { Log } from '@logger/logUtils';

import type * as vscode from 'vscode';

export interface SettingsHandlerContext {
  readonly channel: string;
  readonly log: Log;
  /** VS Code extension context, used to resolve bundled resources. */
  readonly extensionContext: vscode.ExtensionContext;
  /** Run a callback with the active webview, if available. */
  withActiveWebview: (
    fn: (w: vscode.Webview) => Promise<void>,
  ) => Promise<void>;
  /** Post a message to the active webview; a nullish message posts nothing. */
  postMessageToActiveWebview: (message: unknown) => Promise<void>;
}

/**
 * Run `fn`, logging and surfacing any thrown error as a settings-view error
 * message instead of letting it propagate. Shared by every handler delegate
 * to avoid re-typing the same try/catch around each message handler.
 */
export async function withHandlerErrorHandling(
  ctx: SettingsHandlerContext,
  errorMessage: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    await showLoggedErrorMessage(ctx.channel, errorMessage, error);
  }
}
