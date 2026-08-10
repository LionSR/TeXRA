// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports - common
import * as logger from '@logger/logUtils';
import { COMMON_COMMANDS } from '@shared/ipc';
import {
  UnsupportedCommandError,
  type DispatcherFn,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';

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
 * Configuration options for BaseViewMessageHandler.
 */
interface MessageHandlerOptions {
  /**
   * When true, the handler automatically tracks the active webview reference
   * and provides getActiveView() for handlers that need webview access outside
   * the handler callback context.
   *
   * Enable this when handlers need to post messages to the webview from methods
   * that don't receive the webview as a parameter.
   *
   * @default false
   */
  trackActiveView?: boolean;
}

/**
 * Base class for all webview message handlers.
 * Provides consistent error handling, logging, and common patterns.
 * @template T - The webview type (WebviewView or WebviewPanel)
 */
export abstract class BaseViewMessageHandler<
  T extends vscode.WebviewView | vscode.WebviewPanel = vscode.WebviewView,
> {
  protected readonly logger: typeof logger;
  protected readonly channel: string;
  private readonly _options: MessageHandlerOptions;

  /**
   * Active webview reference, tracked when trackActiveView option is enabled.
   * Subclasses can access via getActiveView().
   */
  private _activeView: T | undefined;

  constructor(
    protected readonly viewName: string,
    options?: MessageHandlerOptions,
  ) {
    this.logger = logger;
    this.channel = `${viewName}MessageHandler`;
    this._options = options ?? {};
  }

  /**
   * Get the currently active webview.
   * Only available when trackActiveView option is enabled.
   * @returns The active webview or undefined if not available/not tracking
   */
  protected getActiveView(): T | undefined {
    if (!this._options.trackActiveView) {
      this.logger.warn(
        this.channel,
        'getActiveView called but trackActiveView is not enabled',
      );
    }
    return this._activeView;
  }

  /**
   * Clear the tracked active view (when tracking is enabled).
   */
  public clearActiveView(): void {
    if (this._options.trackActiveView) {
      this._activeView = undefined;
    }
  }

  /**
   * Record the active webview reference when tracking is enabled. No-op
   * otherwise, mirroring {@link clearActiveView}.
   */
  private setActiveView(webviewView: T): void {
    if (this._options.trackActiveView) {
      this._activeView = webviewView;
    }
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
        this.logger.debug(this.channel, 'Message validation failed', {
          data: error,
        });
      } else if (error instanceof UnsupportedCommandError) {
        // Declared `unsupported(...)` in this host's registry: visible
        // feedback (toast), not a silent drop or an error-level log.
        unsupported = true;
        this.logger.debug(this.channel, error.message);
        void vscode.window.showInformationMessage(error.reason);
      } else {
        this.logger.error(this.channel, 'Error handling message', {
          data: error,
        });
      }
    });

    if (!handled && !unsupported && isCommandMessage(message)) {
      this.logger.warn(this.channel, `Unhandled command: ${message.command}`);
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

  /**
   * Helper method for common theme handling
   */
  protected async handleTheme(
    message: { theme?: string },
    webviewView: T,
  ): Promise<void> {
    if (!message?.theme) {
      this.logger.warn(this.channel, 'Invalid theme message', {
        data: message,
      });
      return;
    }

    webviewView.webview.postMessage({
      command: COMMON_COMMANDS.THEME_SET,
      theme: message.theme,
    });
  }

  /**
   * Helper method for common debug mode handling
   */
  protected async handleDebugMode(
    message: { debugMode?: boolean },
    webviewView: T,
  ): Promise<void> {
    webviewView.webview.postMessage({
      command: COMMON_COMMANDS.DEBUG_MODE_SET,
      debugMode: message.debugMode,
    });
  }

  /**
   * Helper method for webview ready state.
   * Subclasses can override this method to perform custom initialization
   * when the webview signals it is ready.
   */
  protected async handleWebviewReady(
    _message: unknown,
    _webviewView: T,
  ): Promise<void> {
    this.logger.debug(this.channel, 'Webview ready signal received');
    // Subclasses can override for custom ready handling
  }
}
