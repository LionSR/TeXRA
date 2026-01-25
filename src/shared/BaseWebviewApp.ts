// Third-party imports
import { LitElement } from 'lit';

// Local imports - webview commands
import { COMMON_COMMANDS } from '@common/webview/commands';

// Local imports - shared webview
import { postMessage } from '@shared/vscode';

/**
 * Base class for Lit-powered webview apps.
 *
 * Handles VS Code message wiring and emits a ready signal on connect.
 */
export abstract class BaseWebviewApp extends LitElement {
  private readonly messageListener = (event: MessageEvent) => {
    this.handleMessage(event.data);
  };

  /**
   * Override to change or suppress the ready command.
   */
  protected get readyCommand(): string | null {
    return COMMON_COMMANDS.WEBVIEW_READY;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('message', this.messageListener);
    const command = this.readyCommand;
    if (command) {
      postMessage(command, {});
    }
  }

  override disconnectedCallback(): void {
    window.removeEventListener('message', this.messageListener);
    super.disconnectedCallback();
  }

  /**
   * Handle raw messages posted from the extension host.
   */
  protected abstract handleMessage(raw: unknown): void;
}
