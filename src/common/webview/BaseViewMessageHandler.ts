import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';

export type MessageHandler = (
  message: any, 
  webviewView: vscode.WebviewView
) => Promise<void>;

/**
 * Base class for all webview message handlers.
 * Provides consistent error handling, logging, and common patterns.
 */
export abstract class BaseViewMessageHandler {
  protected readonly logger: any;
  protected readonly handlers: Record<string, MessageHandler>;

  constructor(protected readonly viewName: string) {
    this.logger = logger;
    logger.initialize(`${viewName}MessageHandler`);
    this.handlers = this.createHandlers();
  }

  /**
   * Subclasses must implement this to provide their specific handlers
   */
  protected abstract createHandlers(): Record<string, MessageHandler>;

  /**
   * Standard message handling with consistent error handling and logging
   */
  public async handleMessage(
    message: any, 
    webviewView: vscode.WebviewView
  ): Promise<void> {
    if (!message?.command) {
      this.logger.warn('Received message without command');
      return;
    }

    this.logger.debug(`Received message: ${message.command}`);

    const handler = this.handlers[message.command];
    if (!handler) {
      this.logger.warn(`Unknown command: ${message.command}`);
      return;
    }

    try {
      await handler(message, webviewView);
    } catch (error) {
      this.logger.error(
        `Error handling command ${message.command}: ${
          error instanceof Error ? error.message : String(error)
        }`
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
  protected async handleTheme(
    message: any, 
    webviewView: vscode.WebviewView
  ): Promise<void> {
    if (!message?.theme) {
      this.logger.warn('Invalid theme message:', message);
      return;
    }
    
    webviewView.webview.postMessage({
      command: 'setTheme',
      theme: message.theme,
    });
  }

  /**
   * Helper method for common debug mode handling
   */
  protected async handleDebugMode(
    message: any, 
    webviewView: vscode.WebviewView
  ): Promise<void> {
    webviewView.webview.postMessage({
      command: 'setDebugMode',
      debugMode: message.debugMode,
    });
  }

  /**
   * Helper method for webview ready state
   */
  protected async handleWebviewReady(
    message: any,
    webviewView: vscode.WebviewView
  ): Promise<void> {
    this.logger.debug('Webview ready signal received');
    // Subclasses can override for custom ready handling
  }
}