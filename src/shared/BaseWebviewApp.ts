// Third-party imports
import { LitElement } from 'lit';
import { provide } from '@lit/context';
import { state } from 'lit/decorators.js';

// Local imports - shared handlers
import { handleCommonMessage } from '@shared/handlers/commonMessageHandlers';

// Local imports - shared contexts
import { themeContext } from '@shared/contexts/themeContext';

// Local imports - webview commands
import { postMessage } from '@shared/vscode';
import { COMMON_COMMANDS } from '@common/webview/commands';
import type { StateRestoreMessage } from '@shared/schemas/commonViewMessages';

// Local imports - shared webview

/**
 * Base class for Lit-powered webview apps.
 *
 * Handles VS Code message wiring and emits a ready signal on connect.
 */
export abstract class BaseWebviewApp extends LitElement {
  @provide({ context: themeContext })
  @state()
  protected theme = '';

  protected debugMode = false;

  private readonly messageListener = (event: MessageEvent) => {
    const handled = handleCommonMessage(event.data, {
      setTheme: (theme) => this.onThemeChange(theme),
      setDebugMode: (enabled) => {
        this.debugMode = enabled;
      },
      restoreState: (message) => this.onStateRestore(message),
      onError: (message, details) => this.onError(message, details),
      onSchemaError: (context, error) => this.logSchemaError(context, error),
    });
    if (!handled) {
      this.handleMessage(event.data);
    }
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

  /**
   * Handle theme updates from the extension host.
   */
  protected onThemeChange(theme: string): void {
    this.theme = theme;
    document.body.className = theme;
  }

  /**
   * Handle state restoration from the extension host.
   */
  protected onStateRestore(_message: StateRestoreMessage): void {
    // Override in subclasses if needed.
  }

  /**
   * Handle error messages from the extension host.
   */
  protected onError(message: string, details?: unknown): void {
    console.error(message, details);
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
