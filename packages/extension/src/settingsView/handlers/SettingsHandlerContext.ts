/**
 * Shared context for domain-specific settings handler delegates — the
 * shared {@link ViewSliceHost} bound by SettingsViewMessageHandler.
 */
import type { ViewSliceHost } from '@common/webview';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';

export type SettingsHandlerContext = ViewSliceHost;

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
