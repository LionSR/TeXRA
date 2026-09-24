/** Shared base for stream panels rendered inside a collapsible wa-details. */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';

import type { RunId } from '@shared/schemas';
import type { Surface } from '@shared/session/surface';
import { dispatchGroupToggle } from '../utils';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

/**
 * A stream panel's open state is the surface's (`Surface.groups`, under the
 * run and the panel's `groupKey`), like the dispatch card's: it survives a
 * run switch and a reload, and a toggle is dispatched, never kept here.
 */
export abstract class CollapsiblePanel extends LitElement {
  @property({ attribute: false }) runId: RunId | null = null;
  @property({ attribute: false }) surface: Surface | null = null;

  /** The panel's key in `Surface.groups` for its run. */
  protected abstract readonly groupKey: string;

  private readonly handleToggle = (event: Event): void => {
    dispatchGroupToggle(this, event, this.runId, this.groupKey);
  };

  /** The shared collapsible scaffold; `body` renders inside the details. */
  protected renderCollapsibleDetails(options: {
    summary: string;
    body: TemplateResult;
  }): TemplateResult {
    const open =
      this.runId !== null &&
      this.surface?.groups.get(this.runId)?.get(this.groupKey) === true;
    return html`
      <wa-details
        class="panel-collapsible is-boxed"
        summary=${options.summary}
        ?open=${open}
        @wa-show=${this.handleToggle}
        @wa-hide=${this.handleToggle}
      >
        ${options.body}
      </wa-details>
    `;
  }
}
