// Third-party imports
import { LitElement } from 'lit';

// Local imports - shared handlers
import { COMMON_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { SignalWatcher } from '@shared/signals';
import { installToolbarTooltips } from '@shared/litControllers/TooltipController';

/**
 * Base class for Lit-powered webview apps.
 *
 * Handles VS Code message wiring and emits a ready signal on connect.
 * Generic parameter TMessage is the typed outbound message union from the
 * backend — subclasses declare the contract so handlers receive typed data
 * instead of `unknown`.
 */

abstract class BaseWebviewApp<TMessage = unknown> extends LitElement {
  private readonly messageListener = (event: MessageEvent) => {
    this.handleMessage(event.data as TMessage);
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
    console.warn(
      `${appLabel} Message validation failed for command "${command}".`,
      error,
    );
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

/**
 * `SignalWatcher(BaseWebviewApp<TMessage>)`, cast once here instead of at
 * each of the three view-root components: `BaseWebviewApp` is abstract, but
 * `SignalWatcher` expects a concrete constructor. Safe because every app
 * subclass implements the abstract members before `@customElement` runs.
 */
export function signalWatcherWebviewAppBase<TMessage = unknown>() {
  return SignalWatcher(
    BaseWebviewApp as unknown as new (
      ...args: any[]
    ) => BaseWebviewApp<TMessage>,
  );
}
