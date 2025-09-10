// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { COMMON_COMMANDS } from './commands';
import * as logger from '@logger/logUtils';

export type MessageHandler<
  T extends vscode.WebviewView | vscode.WebviewPanel = vscode.WebviewView,
> = (message: any, webviewView: T) => Promise<void> | void;

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

  constructor(protected readonly viewName: string) {
    this.logger = logger;
    this.channel = `${viewName}MessageHandler`;
    logger.initialize(this.channel);
    this.handlers = {
      ...this.getBaseHandlers(),
      ...this.createHandlers(),
    };
  }

  /**
   * Subclasses must implement this to provide their specific handlers
   */
  protected abstract createHandlers(): Record<string, MessageHandler<T>>;

  /**
   * Base handlers shared across all webviews
   */
  protected getBaseHandlers(): Record<string, MessageHandler<T>> {
    return {
      [COMMON_COMMANDS.THEME_SET]: (m, w) => this.handleTheme(m, w),
      [COMMON_COMMANDS.DEBUG_MODE_SET]: (m, w) => this.handleDebugMode(m, w),
      [COMMON_COMMANDS.WEBVIEW_READY]: (m, w) => this.handleWebviewReady(m, w),
    };
  }

  /**
   * Standard message handling with consistent error handling and logging
   */
  public async handleMessage(message: any, webviewView: T): Promise<void> {
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
        `Error handling command ${message.command}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      // Optionally notify the webview of the error
      webviewView.webview.postMessage({
        command: 'error',
        message: `Failed to handle command: ${message.command}`,
      });
    }
  }

  /**
   * Helper method for common theme handling
   */
  protected async handleTheme(message: any, webviewView: T): Promise<void> {
    if (!message?.theme) {
      this.logger.warn('Invalid theme message:', message);
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
    message: any,
    webviewView: T,
  ): Promise<void> {
    this.logger.debug('Webview ready signal received');
    // Subclasses can override for custom ready handling
  }
}
