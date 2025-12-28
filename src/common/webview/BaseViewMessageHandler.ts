// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';

// Local file imports
import { COMMON_COMMANDS } from './commands';
import type { z } from 'zod';

export type MessageHandler<
  T extends vscode.WebviewView | vscode.WebviewPanel = vscode.WebviewView,
> = (message: any, webviewView: T) => Promise<void> | void;

/**
 * Configuration options for BaseViewMessageHandler.
 */
export interface MessageHandlerOptions {
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
  protected readonly logger: any;
  protected readonly channel: string;
  protected readonly handlers: Record<string, MessageHandler<T>>;
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
    logger.initialize(this.channel);
    this.handlers = this.createHandlers();
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
      return undefined;
    }

    if (!this._activeView) {
      this.logger.warn(this.channel, 'No active webview available');
      return undefined;
    }

    return this._activeView;
  }

  /**
   * Subclasses must implement this to provide their specific handlers
   */
  protected abstract createHandlers(): Record<string, MessageHandler<T>>;

  /**
   * Standard message handling with consistent error handling and logging.
   * When trackActiveView is enabled, automatically updates the active view reference.
   */
  public async handleMessage(message: any, webviewView: T): Promise<void> {
    // Track active view when option is enabled
    if (this._options.trackActiveView) {
      this._activeView = webviewView;
    }

    if (!message?.command) {
      this.logger.warn(
        this.channel,
        `Received message without command. Message: ${JSON.stringify(message)}`,
      );
      return;
    }

    this.logger.debug(this.channel, `Received message: ${message.command}`);

    const handler = this.handlers[message.command];
    if (!handler) {
      this.logger.warn(this.channel, `Unknown command: ${message.command}`);
      return;
    }

    try {
      await handler(message, webviewView);
    } catch (error) {
      this.logger.error(
        this.channel,
        `Error handling command ${message.command}: ${toErrorMessage(error)}`,
      );

      // Optionally notify the webview of the error
      webviewView.webview.postMessage({
        command: COMMON_COMMANDS.ERROR,
        message: `Failed to handle command: ${message.command}`,
      });
    }
  }

  /**
   * Helper method for common theme handling
   */
  protected async handleTheme(message: any, webviewView: T): Promise<void> {
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
  protected async handleDebugMode(message: any, webviewView: T): Promise<void> {
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

  /**
   * Helper method for validating messages with Zod schemas.
   * Provides consistent validation and error logging pattern.
   *
   * @param schema - Zod schema to validate the message against
   * @param message - The raw message to validate
   * @param messageName - Human-readable name for logging
   * @param handler - Callback to execute with validated data
   */
  protected async withValidatedMessage<S extends z.ZodTypeAny>(
    schema: S,
    message: unknown,
    messageName: string,
    handler: (data: z.infer<S>) => Promise<void> | void,
  ): Promise<void> {
    const parsed = schema.safeParse(message);
    if (!parsed.success) {
      this.logger.debug(this.channel, `Invalid ${messageName}`, {
        data: parsed.error,
      });
      return;
    }
    await handler(parsed.data);
  }
}
