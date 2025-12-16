/**
 * WebviewMessageBroadcaster - Unified message posting utility
 *
 * Consolidates the various message posting patterns used across handlers
 * into a single, consistent API with proper null handling.
 */
import * as vscode from 'vscode';

/**
 * Provides a unified interface for posting messages to a webview.
 *
 * Consolidates three common patterns:
 * 1. `view?.webview.postMessage(m)` - direct forward
 * 2. `view?.webview.postMessage({ command, ...data })` - with modification
 * 3. `if (!view) return; view.webview.postMessage(...)` - with null check
 *
 * Usage:
 * ```typescript
 * class MyHandler extends BaseViewMessageHandler {
 *   private broadcaster: WebviewMessageBroadcaster;
 *
 *   constructor() {
 *     super('MyView', { trackActiveView: true });
 *     this.broadcaster = new WebviewMessageBroadcaster(() => this.getActiveView());
 *   }
 *
 *   private handleSomeCommand() {
 *     this.broadcaster.postCommand('someResponse', { data: 'value' });
 *   }
 * }
 * ```
 */
export class WebviewMessageBroadcaster {
  constructor(
    private readonly getActiveView: () =>
      | vscode.WebviewView
      | vscode.WebviewPanel
      | undefined,
  ) {}

  /**
   * Posts a raw message to the webview.
   *
   * @param message - The message object to post
   * @returns true if the message was posted, false if no active view
   */
  post(message: unknown): boolean {
    const view = this.getActiveView();
    if (!view) {
      return false;
    }
    view.webview.postMessage(message);
    return true;
  }

  /**
   * Posts a command message with optional data to the webview.
   *
   * @param command - The command name
   * @param data - Optional additional data to include in the message
   * @returns true if the message was posted, false if no active view
   */
  postCommand<T extends Record<string, unknown> = Record<string, unknown>>(
    command: string,
    data?: T,
  ): boolean {
    return this.post({ command, ...data });
  }

  /**
   * Posts a message only if the view is available, executing a callback otherwise.
   *
   * @param message - The message to post
   * @param onNoView - Optional callback if no view is available
   * @returns true if the message was posted, false otherwise
   */
  postOrElse(message: unknown, onNoView?: () => void): boolean {
    const success = this.post(message);
    if (!success && onNoView) {
      onNoView();
    }
    return success;
  }

  /**
   * Gets the current active view, if available.
   * Useful for handlers that need direct webview access.
   *
   * @returns The active webview or undefined
   */
  getView(): vscode.WebviewView | vscode.WebviewPanel | undefined {
    return this.getActiveView();
  }

  /**
   * Checks if a view is currently available.
   *
   * @returns true if a view is available
   */
  hasView(): boolean {
    return this.getActiveView() !== undefined;
  }
}
