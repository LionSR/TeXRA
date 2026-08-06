/** Shared base for stream panels rendered inside a collapsible wa-details. */

// Third-party imports
import {
  LitElement,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { property, state } from 'lit/decorators.js';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

/**
 * Holds the collapse-on-context-switch state shared by the stream panels:
 * the parent bumps `collapseKey` (e.g. on stream switches) to reset the
 * panel, and wa-show/wa-hide keep `open` in sync with user toggles.
 */
export abstract class CollapsiblePanel extends LitElement {
  /** When this key changes, the panel collapses. Used by the parent to reset
   *  open state on context switches (e.g. switching streams). */
  @property({ type: String }) collapseKey = '';

  @state() private open = false;

  protected override willUpdate(changed: PropertyValues): void {
    if (
      changed.has('collapseKey') &&
      changed.get('collapseKey') !== undefined
    ) {
      this.open = false;
    }
  }

  /** The shared collapsible scaffold; `body` renders inside the details. */
  protected renderCollapsibleDetails(options: {
    id: string;
    summary: string;
    body: TemplateResult;
  }): TemplateResult {
    return html`
      <wa-details
        id=${options.id}
        class="panel-collapsible is-boxed"
        summary=${options.summary}
        ?open=${this.open}
        @wa-show=${this.handleShow}
        @wa-hide=${this.handleHide}
      >
        ${options.body}
      </wa-details>
    `;
  }

  private handleShow(e: Event): void {
    // Ignore bubbled events from nested wa-details
    if (e.target !== e.currentTarget) return;
    this.open = true;
  }

  private handleHide(e: Event): void {
    if (e.target !== e.currentTarget) return;
    this.open = false;
  }
}
