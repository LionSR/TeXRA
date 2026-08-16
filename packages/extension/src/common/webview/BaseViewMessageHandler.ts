// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports - common
import * as logger from '@logger/logUtils';
import {
  UnsupportedCommandError,
  type DispatcherFn,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';

/** The channel-first logging surface this view and its subclasses use. */
type ViewMessageLogger = {
  debug: (
    channel: string,
    message: string,
    options?: logger.LogUtilsOptions,
  ) => void;
  info: (
    channel: string,
    message: string,
    options?: logger.LogUtilsOptions,
  ) => void;
  warn: (
    channel: string,
    message: string,
    options?: logger.LogUtilsOptions,
  ) => void;
  error: (
    channel: string,
    message: string,
    options?: logger.LogUtilsOptions,
  ) => void;
};

type CommandMessage = { command: string };

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
  protected readonly logger: ViewMessageLogger;
  protected readonly channel: string;

  /**
   * Active webview reference, tracked on every dispatch. Subclasses access it
   * via getActiveView().
   */
  private _activeView: T | undefined;

  constructor(protected readonly viewName: string) {
    this.logger = logger;
    this.channel = `${viewName}MessageHandler`;
  }

  /** Channel-bound log for this handler's own inbound diagnostics. */
  private get log() {
    return logger.createLog(this.channel);
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

  /**
   * Record the active webview reference.
   */
  private setActiveView(webviewView: T): void {
    this._activeView = webviewView;
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
   * Extension point invoked at the start of {@link dispatchInbound}, before
   * the dispatcher runs. Subclasses that need per-message setup against the
   * active webview (e.g. attaching it to sub-managers) override this instead
   * of reimplementing dispatch.
   */
  protected onDispatch?(webviewView: T): void;

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
    this.setActiveView(webviewView);
    this.onDispatch?.(webviewView);

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
        void vscode.window.showInformationMessage(error.reason);
      } else {
        this.log.error('Error handling message', {
          data: error,
        });
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
