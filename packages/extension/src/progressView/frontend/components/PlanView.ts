/**
 * PlanView component - renders the plan as a plain objective document
 * inside a collapsible panel.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import type { Plan } from '@shared/schemas';
import type { Surface } from '@shared/session/surface';
import { designTokens, commonViewStyles } from '@ui/styles';
import { dispatchGroupToggle } from '../utils';
import type { RunId } from '@texra-ai/harness/schemas';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

/** The panel's key in `Surface.groups` for its run. */
const GROUP_KEY = 'plan';

/**
 * The panel's open state is the surface's (`Surface.groups`, under the run
 * and `GROUP_KEY`), like the dispatch card's: it survives a run switch and a
 * reload, and a toggle is dispatched, never kept here.
 */
@customElement('plan-view')
export class PlanView extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .plan-body {
        max-height: var(--height-xlarge);
        overflow-y: auto;
      }

      .plan-document {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        unicode-bidi: plaintext;
        font-size: var(--font-size);
        line-height: var(--line-height-relaxed);
        color: var(--color-text-secondary);
        padding: var(--wa-space-3xs) 0 var(--wa-space-2xs);
      }
    `,
  ];

  @property({ attribute: false }) runId: RunId | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  @property({ attribute: false }) plan: Plan | null = null;

  private readonly handleToggle = (event: Event): void => {
    dispatchGroupToggle(this, event, this.runId, GROUP_KEY);
  };

  override render(): TemplateResult | typeof nothing {
    if (!this.plan) {
      return nothing;
    }
    const open =
      this.runId !== null &&
      this.surface?.groups.get(this.runId)?.get(GROUP_KEY) === true;

    // The body is kept to one line so the pre-wrap document gets no
    // template whitespace.
    // prettier-ignore
    return html`
      <wa-details
        class="panel-collapsible is-boxed"
        summary="Plan"
        ?open=${open}
        @wa-show=${this.handleToggle}
        @wa-hide=${this.handleToggle}
      ><div class="plan-body"><div class="plan-document">${this.plan.objective}</div></div></wa-details>
    `;
  }
}
