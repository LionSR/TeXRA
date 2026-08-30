// Third-party imports
import { LitElement } from 'lit';

// Local imports - shared handlers
import { COMMON_COMMANDS } from '@shared/ipc';
import { logWarn } from '@shared/log';
import { postMessage } from '@shared/hostBridge';
import {
  CommonViewMessageSchema,
  type StateRestoreMessage,
  type Theme,
} from '@shared/schemas';
import { installToolbarTooltips } from '@shared/litControllers/TooltipController';

import type { ZodError } from 'zod';

interface CommonMessageContext {
  setTheme: (theme: Theme) => void;
  setDebugMode: (enabled: boolean) => void;
  restoreState: (message: StateRestoreMessage) => void;
  onSchemaError?: (context: string, error: ZodError) => void;
}

function handleCommonMessage(
  raw: unknown,
  context: CommonMessageContext,
): boolean {
  const result = CommonViewMessageSchema.safeParse(raw);
  if (!result.success) {
    context.onSchemaError?.(
      '[CommonMessage] Schema validation failed.',
      result.error,
    );
    return false;
  }

  switch (result.data.command) {
    case COMMON_COMMANDS.THEME_SET:
      context.setTheme(result.data.theme);
      return true;
    case COMMON_COMMANDS.DEBUG_MODE_SET:
      context.setDebugMode(result.data.debugMode);
      return true;
    case COMMON_COMMANDS.STATE_RESTORE:
      context.restoreState(result.data);
      return true;
    case COMMON_COMMANDS.WEBVIEW_READY:
      return true;
    // Every other common command falls through to `default`: unknown commands
    // (including SWITCH_VIEW) are passed to the subclass's handleMessage.
    default:
      return false;
  }
}

/**
 * Base class for Lit-powered webview apps.
 *
 * Handles VS Code message wiring and emits a ready signal on connect.
 * Generic parameter TMessage is the typed outbound message union from the
 * backend — subclasses declare the contract so handlers receive typed data
 * instead of `unknown`.
 */

export abstract class BaseWebviewApp<TMessage = unknown> extends LitElement {
  protected debugMode = false;

  private readonly messageListener = (event: MessageEvent) => {
    const handled = handleCommonMessage(event.data, {
      setTheme: () => {},
      setDebugMode: (enabled) => {
        this.debugMode = enabled;
      },
      restoreState: (message) => this.onStateRestore(message),
      onSchemaError: (context, error) => this.logSchemaError(context, error),
    });
    if (!handled) {
      this.handleMessage(event.data as TMessage);
    }
  };

  /**
   * True when this webview is mounted by the Electron desktop renderer.
   *
   * Why two checks: under normal operation `window.texraDesktop` is wired by
   * the preload bridge and is sufficient on its own. The `data-desktop-view`
   * attribute is the fallback for tests and Storybook-style harnesses that
   * mount these components without the preload bridge — they can opt into
   * the desktop layout by setting the attribute on the host element. The VS
   * Code extension host sets neither.
   */
  protected get isDesktopHost(): boolean {
    return (
      this.hasAttribute('data-desktop-view') ||
      Object.hasOwn(window, 'texraDesktop')
    );
  }

  /**
   * Log schema validation errors in debug mode.
   */
  protected logSchemaError(context: string, error: unknown): void {
    if (!this.debugMode) {
      return;
    }
    logWarn(context, error);
  }

  /**
   * Dispatcher `onError` reporter: names the command the raw message claimed
   * so a validation failure points at one command instead of the whole union.
   * `appLabel` is the bracketed app tag (e.g. `[ProgressApp]`).
   */
  protected logMessageSchemaError(
    appLabel: string,
    raw: unknown,
    error: unknown,
  ): void {
    const command =
      raw && typeof raw === 'object' && 'command' in raw
        ? String((raw as { command: unknown }).command)
        : 'unknown';
    this.logSchemaError(
      `${appLabel} Message validation failed for command "${command}".`,
      error,
    );
  }

  /**
   * Handle state restoration from the extension host.
   */
  protected onStateRestore(_message: StateRestoreMessage): void {
    // Override in subclasses if needed.
  }

  override connectedCallback(): void {
    super.connectedCallback();
    installToolbarTooltips();
    window.addEventListener('message', this.messageListener);
    this.postReady();
  }

  /** Tell the host this view is mounted, tagged with the desktop surface. */
  protected postReady(): void {
    const view = this.getAttribute('data-desktop-view');
    postMessage(COMMON_COMMANDS.WEBVIEW_READY, view == null ? {} : { view });
  }

  override disconnectedCallback(): void {
    window.removeEventListener('message', this.messageListener);
    super.disconnectedCallback();
  }

  /**
   * Handle typed messages posted from the extension host.
   * The backend sends TMessage objects via postMessage (structured clone).
   */
  protected abstract handleMessage(message: TMessage): void;
}
