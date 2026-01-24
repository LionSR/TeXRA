// Third-party imports
import { LitElement } from 'lit';

// Local imports
import { postMessage } from './vscode';

/**
 * Base Lit webview app with standard message wiring.
 */
export abstract class BaseWebviewApp extends LitElement {
  private readonly messageListener = (event: MessageEvent) => {
    this.handleIncomingMessage(event.data);
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('message', this.messageListener);
    this.onWebviewReady();
  }

  disconnectedCallback(): void {
    window.removeEventListener('message', this.messageListener);
    super.disconnectedCallback();
  }

  protected onWebviewReady(): void {
    postMessage('webviewReady');
  }

  protected abstract handleIncomingMessage(message: unknown): void;
}
