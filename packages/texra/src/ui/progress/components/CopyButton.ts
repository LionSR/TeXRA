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
import { html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports
import { CopyButtonController } from '@ui/litControllers/CopyButtonController';
import { waIcon } from '@ui/wa/webAwesomeIcons';

/** The three places a template puts a Copy button, each with its look. */
type CopyButtonLook = 'icon' | 'labeled' | 'code';

const LOOK_CLASS: Readonly<Record<CopyButtonLook, string>> = {
  icon: 'action-icon-button banner-content-copy',
  labeled: 'action-button message-copy banner-content-copy',
  code: 'code-block-copy',
};

/**
 * Keep an Enter/Space keydown from reaching an enclosing `<wa-details>`
 * summary, whose keydown handler toggles the panel and calls
 * `preventDefault()`, which would also cancel the button's own activation.
 * The click the browser synthesizes from the key still happens.
 */
function stopSummaryToggleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.stopPropagation();
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
    const content =
      this.look === 'labeled'
        ? html`${copied ? 'Copied' : 'Copy'}`
        : waIcon('copy');
    // prettier-ignore
    return html`<wa-button class="${LOOK_CLASS[this.look]}${copied ? ' copy-success' : ''}" appearance="plain" variant="neutral" size="s" type="button" title=${title} aria-label=${title} @click=${this.handleClick} @keydown=${stopSummaryToggleKeydown}>${content}</wa-button>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'copy-button': CopyButton;
  }
}
