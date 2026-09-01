// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports - common
import { createLog, type Log } from '@logger/logUtils';
import {
  UnsupportedCommandError,
  type DispatcherFn,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';

type CommandMessage = { command: string };

/**
 * Slice-visible face of {@link BaseViewMessageHandler}: channel, log, the
 * VS Code extension context, and the two accessors inbound command slices
 * and handler delegates share.
 *
 * Posting is the awaited {@link BaseViewMessageHandler.postMessageToActiveWebview}
 * path, not fire-and-forget {@link BaseViewMessageHandler.postToActiveView}.
 * Mutation follow-ups (a settings refresh after a write; hide-banner then
 * credential refresh) depend on delivery having settled. Fire-and-forget
 * posts stay as a protected method on the handler class for intra-class use
 * (manager outbound, theme/debug) where ordering is not a follow-up contract.
 *
 * `withActiveWebview` is the shared "run with the active webview" accessor
 * (`vscode.Webview`). View-wrapper access (`vscode.WebviewView`) stays
 * view-specific — main-view recording needs the view, not just the webview.
 */
export interface ViewSliceHost {
  readonly channel: string;
  readonly log: Log;
  readonly extensionContext: vscode.ExtensionContext;
  withActiveWebview(
    fn: (webview: vscode.Webview) => Promise<void> | void,
  ): Promise<void>;
  postMessageToActiveWebview(message: unknown): Promise<void>;
}

/** Type guard to check if a message has a command field */
function isCommandMessage(
  message: unknown,
): message is { command: string; [key: string]: unknown } {
  return (
    typeof message === 'object' &&
    message !== null &&
    'command' in message &&
    typeof (message as Record<string, unknown>).command === 'string'
  );
}

/**
 * Base class for all webview message handlers.
 * Provides consistent error handling, logging, and common patterns.
 * @template T - The webview type (WebviewView or WebviewPanel)
 */
export abstract class BaseViewMessageHandler<
  T extends vscode.WebviewView | vscode.WebviewPanel = vscode.WebviewView,
> {
  protected readonly channel: string;
  protected readonly log: Log;

  /**
   * Active webview reference, tracked on every dispatch. Subclasses access it
   * via getActiveView().
   */
  private _activeView: T | undefined;

  constructor(protected readonly viewName: string) {
    this.channel = `${viewName}MessageHandler`;
    this.log = createLog(this.channel);
  }

  /**
   * Get the currently active webview.
   * @returns The active webview or undefined if no message has been dispatched yet
   */
  protected getActiveView(): T | undefined {
    return this._activeView;
  }

  /**
   * Clear the tracked active view.
   */
  public clearActiveView(): void {
    this._activeView = undefined;
  }

  /** Keep a failed notification from becoming an unhandled host rejection. */
  private reportNotificationFailure(notification: PromiseLike<unknown>): void {
    void notification.then(undefined, (error: unknown) => {
      this.log.error('Failed to display message notification', {
        data: error,
      });
    });
  }

  /** Bind the slice-visible subset of this handler for command delegates. */
  protected bindViewSliceHost(
    extensionContext: vscode.ExtensionContext,
  ): ViewSliceHost {
    return {
      channel: this.channel,
      log: this.log,
      extensionContext,
      withActiveWebview: (fn) => this.withActiveWebview(fn),
      postMessageToActiveWebview: (message) =>
        this.postMessageToActiveWebview(message),
    };
  }

  /** Post a message to the tracked active view, if one is available. */
  protected postToActiveView(message: unknown): void {
    this.getActiveView()?.webview.postMessage(message);
  }

  /** Run a callback with the active view's webview, if available. */
  protected async withActiveWebview(
    fn: (webview: vscode.Webview) => Promise<void> | void,
  ): Promise<void> {
    const view = this.getActiveView();
    if (view) await fn(view.webview);
  }

  /**
   * Post a message to the active view's webview, awaiting delivery. A `null`
   * or `undefined` message posts nothing, so callers can forward an optional
   * response payload without a guard of their own. Unlike
   * {@link postToActiveView}, this resolves only after the post settles —
   * mutation paths that run a follow-up step depend on that ordering.
   */
  protected async postMessageToActiveWebview(message: unknown): Promise<void> {
    if (message == null) return;
    await this.withActiveWebview(async (webview) => {
      await webview.postMessage(message);
    });
  }

  /**
   * Schema-driven dispatch shared by views that route through a typed
   * {@link DispatcherFn}. Tracks the active view, runs the dispatcher, logs
   * Zod validation failures at debug (expected, frequent) and handler
   * exceptions at error (a real bug), and warns on commands with no handler.
   */
  protected async dispatchInbound<TMessage extends CommandMessage>(
    message: unknown,
    webviewView: T,
    dispatcher: DispatcherFn<TMessage>,
    handlers: HandlerRegistry<TMessage>,
  ): Promise<void> {
    this._activeView = webviewView;

    let unsupported = false;
    const handled = dispatcher(message, handlers, (error) => {
      if (error instanceof ZodError) {
        this.log.debug('Message validation failed', {
          data: error,
        });
      } else if (error instanceof UnsupportedCommandError) {
        // Declared `unsupported(...)` in this host's registry: visible
        // feedback (toast), not a silent drop or an error-level log.
        unsupported = true;
        this.log.debug(error.message);
        this.reportNotificationFailure(
          vscode.window.showInformationMessage(error.reason),
        );
      } else {
        this.log.error('Error handling message', {
          data: error,
        });
        this.reportNotificationFailure(
          vscode.window.showErrorMessage(
            `TeXRA could not handle a ${this.viewName} message. See the TeXRA output for details.`,
          ),
        );
      }
    });

    if (!handled && !unsupported && isCommandMessage(message)) {
      this.log.warn(`Unhandled command: ${message.command}`);
    }
  }

  /**
   * Entry point for inbound webview messages. Subclasses route through
   * {@link dispatchInbound} with their typed dispatcher and registry.
   */
  public abstract handleMessage(
    message: unknown,
    webviewView: T,
  ): Promise<void>;
}
