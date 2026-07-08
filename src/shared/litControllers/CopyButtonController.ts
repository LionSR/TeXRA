import {
  copyTextToClipboard,
  COPY_RESET_DELAY_MS,
} from '@shared/utils/clipboard';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

interface CopyButtonConfig {
  /** Default button title/tooltip */
  defaultTitle?: string;
  /** Title shown after successful copy */
  successTitle?: string;
  /** CSS class applied during success state */
  successClass?: string;
  /** Delay before resetting to default state (ms) */
  resetDelay?: number;
}

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
  private _resetTimeoutId: number | null = null;
  private readonly _config: Required<CopyButtonConfig>;

  constructor(
    private readonly host: ReactiveControllerHost,
    config: CopyButtonConfig = {},
  ) {
    this._config = {
      defaultTitle: config.defaultTitle ?? 'Copy to clipboard',
      successTitle: config.successTitle ?? 'Copied!',
      successClass: config.successClass ?? 'copy-success',
      resetDelay: config.resetDelay ?? COPY_RESET_DELAY_MS,
    };
    this.host.addController(this);
  }

  hostDisconnected(): void {
    this.clearResetTimer();
  }

  private clearResetTimer(): void {
    if (this._resetTimeoutId !== null) {
      window.clearTimeout(this._resetTimeoutId);
      this._resetTimeoutId = null;
    }
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
      successClass: this._config.successClass,
    };
  }

  /**
   * Copy text to clipboard and show success feedback.
   * Automatically resets to default state after the configured delay.
   */
  copy = async (text: string): Promise<boolean> => {
    if (!text.trim()) {
      return false;
    }

    this.clearResetTimer();

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

    this._resetTimeoutId = window.setTimeout(() => {
      this._copied = false;
      this._resetTimeoutId = null;
      this.host.requestUpdate();
    }, this._config.resetDelay);

    return true;
  };
}
