/**
 * The Copy button a formatter template draws: a `<copy-button>` holds its
 * own copied state through `CopyButtonController`, so a template that has no
 * component of its own still gets the one copy feedback.
 *
 * It renders into its light DOM, so the enclosing view's styles (the
 * message-header, details-summary and code-block rules) reach the
 * `<wa-button>` it draws; the host itself lays out as its button.
 */

// Third-party imports
import { LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports
import { CopyButtonController } from '@ui/litControllers/CopyButtonController';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { isActivationKey } from '@ui/wa/keyActivation';

/** The three places a template puts a Copy button, each with its look. */
type CopyButtonLook = 'icon' | 'labeled' | 'code';

const LOOK_CLASS: Readonly<Record<CopyButtonLook, string | undefined>> = {
  icon: 'banner-content-copy',
  labeled: 'message-copy banner-content-copy',
  code: undefined,
};

/**
 * Keep an Enter/Space keydown from reaching an enclosing `<wa-details>`
 * summary, whose keydown handler toggles the panel and calls
 * `preventDefault()`, which would also cancel the button's own activation.
 * The click the browser synthesizes from the key still happens.
 */
function stopSummaryToggleKeydown(event: KeyboardEvent): void {
  if (isActivationKey(event)) event.stopPropagation();
}

@customElement('copy-button')
export class CopyButton extends LitElement {
  /** The text the button copies. */
  @property({ attribute: false }) text = '';
  /** The button's name and its hover hint before a copy. */
  @property({ attribute: false }) label = 'Copy';
  @property({ attribute: false }) look: CopyButtonLook = 'icon';

  private readonly copier = new CopyButtonController(this);

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = 'contents';
    // The host is the button's only light-DOM parent, so its keydown
    // reaches here before any enclosing summary. Re-adding one listener on
    // reconnect is a no-op.
    this.addEventListener('keydown', stopSummaryToggleKeydown);
  }

  /**
   * A click inside a `<wa-details>` summary would also toggle the panel,
   * and a slotted custom button can still trigger the native summary's
   * default action, so the click stops here.
   */
  private handleClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    void this.copier.copy(this.text);
  };

  override render(): TemplateResult {
    const { copied } = this.copier;
    const title = copied ? 'Copied!' : this.label;
    const className = [LOOK_CLASS[this.look], copied ? 'copy-success' : '']
      .filter(Boolean)
      .join(' ');
    const shared = { title, className, onClick: this.handleClick };
    return this.look === 'labeled'
      ? renderLabeledActionButton({
          ...shared,
          text: copied ? 'Copied' : 'Copy',
          label: title,
        })
      : renderIconActionButton({ ...shared, icon: 'copy', label: title });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'copy-button': CopyButton;
  }
}
