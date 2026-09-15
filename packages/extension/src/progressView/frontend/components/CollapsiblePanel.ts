/** Shared base for stream panels rendered inside a collapsible wa-details. */

// Third-party imports
import {
  LitElement,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { property } from 'lit/decorators.js';

import { DetailsOpenController } from '@shared/litControllers/DetailsOpenController';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

/**
 * Holds the collapse-on-context-switch state shared by the stream panels:
 * the parent bumps `collapseKey` (e.g. on stream switches) to reset the
 * panel, and wa-show/wa-hide keep `open` in sync with user toggles.
 */
export abstract class CollapsiblePanel extends LitElement {
  /** When this key changes, the panel collapses. Used by the parent to reset
   *  open state on context switches (e.g. switching runs). */
  @property({ type: String }) collapseKey = '';

  private readonly details = new DetailsOpenController(this);

  protected override willUpdate(changed: PropertyValues): void {
    if (
      changed.has('collapseKey') &&
      changed.get('collapseKey') !== undefined
    ) {
      this.details.open = false;
    }
  }

  /** The shared collapsible scaffold; `body` renders inside the details. */
  protected renderCollapsibleDetails(options: {
    summary: string;
    body: TemplateResult;
  }): TemplateResult {
    return html`
      <wa-details
        class="panel-collapsible is-boxed"
        summary=${options.summary}
        ?open=${this.details.open}
        @wa-show=${this.details.handleShow}
        @wa-hide=${this.details.handleHide}
      >
        ${options.body}
      </wa-details>
    `;
  }
}
