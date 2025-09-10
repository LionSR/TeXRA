// Local imports - webview
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

const providerCommandMap = {
  [MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY]:
    MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY,
  [MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE]:
    MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL,
};

/**
 * Send an API key-related message, adjusting for provider-specific context.
 * @param {string | undefined} provider Provider identifier.
 * @param {string} commandWhenNone Command to send when no provider is specified.
 */
export function sendApiKeyMessage(provider, commandWhenNone) {
  const command = provider
    ? providerCommandMap[commandWhenNone]
    : commandWhenNone;
  if (!command) {
    return;
  }
  const message = provider ? { command, provider } : { command };
  vscode.postMessage(message);
}
