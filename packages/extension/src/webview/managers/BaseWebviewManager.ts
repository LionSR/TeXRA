// Third-party imports
import * as vscode from 'vscode';

import {
  MainViewMessageSchema,
  type MainViewMessage,
} from '@shared/schemas/mainView';
import { assertOutboundMessage } from '@shared/utils/dispatcher';

/**
 * Base class for webview managers that need to post messages to the webview.
 * Provides common webview attachment and message posting patterns.
 */
export abstract class BaseWebviewManager {
  protected webview: vscode.WebviewView | undefined;

  attachWebview(webviewView: vscode.WebviewView): void {
    this.webview = webviewView;
  }

  /** Post a message to the webview if attached */
  protected postMessage(message: MainViewMessage): void {
    // Dev/test-only: every BaseWebviewManager subclass sends MainView
    // outbound messages exclusively, so a shape mismatch here is always a
    // real drift between the schema and the producer, not an out-of-scope
    // command. See `assertOutboundMessage` for the prod no-op rationale.
    assertOutboundMessage(MainViewMessageSchema, message);
    this.webview?.webview.postMessage(message);
  }
}
