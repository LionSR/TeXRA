// Third-party imports
import { LitElement } from 'lit';

// Local imports - webview commands
import { postMessage } from '@shared/vscode';
import { COMMON_COMMANDS } from '@common/webview/commands';

// Local imports - shared webview

/**
 * Base class for Lit-powered webview apps.
 *
 * Handles VS Code message wiring and emits a ready signal on connect.
 */
export abstract class BaseWebviewApp extends LitElement {
  protected debugMode = false;

  private readonly messageListener = (event: MessageEvent) => {
    const data = event.data as { command?: string; debugMode?: boolean } | null;
    if (data?.command === COMMON_COMMANDS.DEBUG_MODE_SET) {
      this.debugMode = Boolean(data.debugMode);
      return;
    }
    this.handleMessage(event.data);
  };

  /**
   * Override to change or suppress the ready command.
   */
  protected get readyCommand(): string | null {
    return COMMON_COMMANDS.WEBVIEW_READY;
  }

  /**
   * Log schema validation errors in debug mode.
   */
  protected logSchemaError(context: string, error: unknown): void {
    if (!this.debugMode) {
      return;
    }
    console.warn(context, error);
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
