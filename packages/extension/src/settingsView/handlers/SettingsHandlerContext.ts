import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { Log } from '@logger/logUtils';
import type { ExtensionContext, Webview } from 'vscode';

/**
 * The slice-visible face of `SettingsViewMessageHandler`: the channel and log
 * it reports through, the VS Code extension context, and the two accessors
 * inbound command slices and handler delegates share.
 *
 * Posting is the awaited `postMessageToActiveWebview` path. Mutation
 * follow-ups (a settings refresh after a write; hide-banner then credential
 * refresh) depend on delivery having settled.
 *
 * `withActiveWebview` is the shared "run with the active webview" accessor
 * (`vscode.Webview`). View-wrapper access (`vscode.WebviewView`) stays
 * view-specific.
 */
export interface SettingsHandlerContext {
  readonly channel: string;
  readonly log: Log;
  readonly extensionContext: ExtensionContext;
  withActiveWebview(
    fn: (webview: Webview) => Promise<void> | void,
  ): Promise<void>;
  postMessageToActiveWebview(message: unknown): Promise<void>;
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
