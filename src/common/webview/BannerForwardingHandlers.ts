/**
 * BannerForwardingHandlers - Factory for banner message forwarding
 *
 * Consolidates the repetitive banner show/hide handlers that simply
 * forward messages to the webview without additional processing.
 */
import * as vscode from 'vscode';

import type { MessageHandler } from './BaseViewMessageHandler';

/**
 * Banner command pair configuration.
 */
export interface BannerCommandPair {
  /** Command to show the banner */
  show: string;
  /** Command to hide the banner */
  hide: string;
}

/**
 * Creates handlers that forward banner messages directly to the webview.
 *
 * Usage:
 * ```typescript
 * const bannerHandlers = createBannerForwardingHandlers(
 *   () => this.getActiveView(),
 *   [
 *     { show: COMMANDS.SHOW_API_KEY_BANNER, hide: COMMANDS.HIDE_API_KEY_BANNER },
 *     { show: COMMANDS.SHOW_AGENT_CONFIG_BANNER, hide: COMMANDS.HIDE_AGENT_CONFIG_BANNER },
 *   ]
 * );
 * // In createHandlers(): ...bannerHandlers
 * ```
 *
 * @param getActiveView - Function to get the current active webview
 * @param bannerCommands - Array of banner command pairs to handle
 * @returns Handler map entries to spread into createHandlers()
 */
export function createBannerForwardingHandlers(
  getActiveView: () => vscode.WebviewView | undefined,
  bannerCommands: BannerCommandPair[],
): Record<string, MessageHandler<vscode.WebviewView>> {
  const handlers: Record<string, MessageHandler<vscode.WebviewView>> = {};

  for (const { show, hide } of bannerCommands) {
    // Show handler - forwards message with any additional data
    handlers[show] = async (message) => {
      const view = getActiveView();
      view?.webview.postMessage(message);
    };

    // Hide handler - forwards message
    handlers[hide] = async (message) => {
      const view = getActiveView();
      view?.webview.postMessage(message);
    };
  }

  return handlers;
}

/**
 * Creates a single forwarding handler for a command.
 * Useful for commands that just need to pass through to the webview.
 *
 * @param getActiveView - Function to get the current active webview
 * @returns A handler that forwards messages to the webview
 */
export function createForwardingHandler(
  getActiveView: () => vscode.WebviewView | undefined,
): MessageHandler<vscode.WebviewView> {
  return async (message) => {
    const view = getActiveView();
    view?.webview.postMessage(message);
  };
}
