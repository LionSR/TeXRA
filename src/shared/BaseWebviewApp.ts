// Third-party imports
import { LitElement } from 'lit';

/**
 * Base class for Lit-powered VS Code webviews.
 * Handles message wiring and enforces light DOM rendering.
 */
export abstract class BaseWebviewApp extends LitElement {
  protected readonly messageListener = (event: MessageEvent) => {
    this.handleMessage(event.data);
  };

  protected abstract handleMessage(message: unknown): void;

  protected onWebviewReady(): void {
    // Optional hook for derived classes.
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('message', this.messageListener);
    this.onWebviewReady();
  }

  override disconnectedCallback(): void {
    window.removeEventListener('message', this.messageListener);
    super.disconnectedCallback();
  }
}
