import {
  createFlushableDebounce,
  type FlushableDebounce,
} from '@texra/utils/core/flushableDebounce';
import {
  copyTextToClipboard,
  COPY_RESET_DELAY_MS,
} from '@texra/shared/utils/clipboard';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

interface CopyButtonConfig {
  /** Default button title/tooltip */
  defaultTitle?: string;
  /** Title shown after successful copy */
  successTitle?: string;
}

/** CSS class applied during the success state. */
const SUCCESS_CLASS = 'copy-success';

/**
 * Computed state for copy button (used in templates).
 */
interface CopyButtonState {
  /** Current title/tooltip text */
  title: string;
  /** Current aria-label */
  ariaLabel: string;
  /** Whether in success/copied state */
  copied: boolean;
  /** CSS class for success state */
  successClass: string;
}

/**
 * Lit reactive controller for managing a copy button with visual feedback.
 *
 * Exposes computed state that the host component can use in templates:
 * ```typescript
 * // In host component
 * private copyController = new CopyButtonController(this, {
 *   defaultTitle: 'Copy instruction',
 *   successTitle: 'Copied!',
 * });
 *
 * render() {
 *   const { title, ariaLabel, copied, successClass } = this.copyController.state;
 *   return html`
 *     <vscode-toolbar-button
 *       icon="copy"
 *       title=${title}
 *       aria-label=${ariaLabel}
 *       class=${classMap({ [successClass]: copied })}
 *       @click=${() => this.copyController.copy(this.textToCopy)}
 *     ></vscode-toolbar-button>
 *   `;
 * }
 * ```
 */
export class CopyButtonController implements ReactiveController {
  private _copied = false;
  private readonly _config: Required<CopyButtonConfig>;
  private readonly _resetTimer: FlushableDebounce;

  private readonly host: ReactiveControllerHost;
  constructor(host: ReactiveControllerHost, config: CopyButtonConfig = {}) {
    this.host = host;
    this._config = {
      defaultTitle: config.defaultTitle ?? 'Copy to clipboard',
      successTitle: config.successTitle ?? 'Copied!',
    };
    this._resetTimer = createFlushableDebounce(() => {
      this._copied = false;
      this.host.requestUpdate();
    }, COPY_RESET_DELAY_MS);
    this.host.addController(this);
  }

  hostDisconnected(): void {
    this._resetTimer.cancel();
  }

  /**
   * Get computed state for use in templates (Lit-native approach).
   * The host component should use these values in its template bindings.
   */
  get state(): CopyButtonState {
    const title = this._copied
      ? this._config.successTitle
      : this._config.defaultTitle;
    return {
      title,
      ariaLabel: title,
      copied: this._copied,
      successClass: SUCCESS_CLASS,
    };
  }

  /**
   * Copy text to clipboard and show success feedback.
   * Automatically resets to default state after `COPY_RESET_DELAY_MS`.
   */
  copy = async (text: string): Promise<boolean> => {
    if (!text.trim()) {
      return false;
    }

    this._resetTimer.cancel();

    if (this._copied) {
      this._copied = false;
      this.host.requestUpdate();
    }

    const success = await copyTextToClipboard(text);
    if (!success) {
      return false;
    }

    this._copied = true;
    this.host.requestUpdate();

    this._resetTimer.schedule();

    return true;
  };
}
