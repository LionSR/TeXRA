// Third-party imports
import { LitElement } from 'lit';
import { createContext, provide } from '@lit/context';
import { state } from 'lit/decorators.js';

// Local imports - shared handlers
import { COMMON_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { installToolbarTooltips } from '@shared/litControllers/TooltipController';

// Local imports - webview commands
import {
  CommonViewMessageSchema,
  type StateRestoreMessage,
} from '@shared/schemas/commonViewMessages';
import { setWaColorScheme, themeIsDark } from '@shared/wa/waColorScheme';
import type { ZodError } from 'zod';

interface CommonMessageContext {
  setTheme: (theme: string) => void;
  setDebugMode: (enabled: boolean) => void;
  restoreState: (message: StateRestoreMessage) => void;
  onError: (message: string, details?: unknown) => void;
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
    case COMMON_COMMANDS.ERROR:
      context.onError(result.data.message, result.data.details);
      return true;
    case COMMON_COMMANDS.WEBVIEW_READY:
      return true;
    // Every other common command falls through to `default`: unknown commands
    // (including SWITCH_VIEW) are passed to the subclass's handleMessage.
    default:
      return false;
  }
}

export const themeContext = createContext<string>('shared-theme');

/**
 * Base class for Lit-powered webview apps.
 *
 * Handles VS Code message wiring and emits a ready signal on connect.
 * Generic parameter TMessage is the typed outbound message union from the
 * backend — subclasses declare the contract so handlers receive typed data
 * instead of `unknown`.
 */

export abstract class BaseWebviewApp<TMessage = unknown> extends LitElement {
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
      this.handleMessage(event.data as TMessage);
    }
  };

  /**
   * Override to change or suppress the ready command.
   */
  protected get readyCommand(): string | null {
    return COMMON_COMMANDS.WEBVIEW_READY;
  }

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
    console.warn(context, error);
  }

  /**
   * Handle theme updates from the extension host.
   *
   * Mirrors the theme kind onto `<html>` as `wa-light` / `wa-dark` so Web
   * Awesome's color-scheme classes activate (per WA's native theming model).
   * Also keeps the legacy `body.<theme>` class for downstream rules.
   */
  protected onThemeChange(theme: string): void {
    this.theme = theme;
    document.body.className = theme;
    // 'high-contrast' renders against the active OS color-scheme — pick dark
    // unless the body class explicitly signals light HC. Defer the actual
    // class swap to the shared helper so the class set + ordering stays in
    // one place across hosts. Reuse `themeIsDark()` for the typed ('dark' /
    // 'high-contrast') case so the dark-detection rule lives next to the
    // desktop renderer's path in @shared/wa/hostTheme.
    const isTypedDark =
      (theme === 'dark' || theme === 'light' || theme === 'high-contrast') &&
      themeIsDark(theme);
    const wantsDark =
      isTypedDark ||
      document.body.classList.contains('vscode-dark') ||
      document.body.classList.contains('vscode-high-contrast');
    setWaColorScheme(wantsDark);
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
    installToolbarTooltips();
    window.addEventListener('message', this.messageListener);
    const command = this.readyCommand;
    if (command) {
      const view = this.getAttribute('data-desktop-view');
      postMessage(command, view == null ? {} : { view });
    }
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
