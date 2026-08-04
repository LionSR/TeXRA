/**
 * PlanView component - renders the plan as a plain objective document
 * inside a collapsible panel. Step tracking lives in the todo tool.
 */

// Third-party imports
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import type { Plan } from '@shared/schemas';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

@customElement('plan-view')
export class PlanView extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .plan-body {
        max-height: var(--height-xlarge);
        overflow-y: auto;
      }

      .plan-document {
        white-space: pre-wrap;
        word-break: break-word;
        font-size: var(--font-size);
        line-height: var(--line-height-relaxed);
        color: var(--color-text-secondary);
        padding: var(--wa-space-3xs) 0 var(--wa-space-2xs);
      }
    `,
  ];

  @property({ attribute: false }) plan: Plan | null = null;

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

  override render(): TemplateResult | typeof nothing {
    if (!this.plan) {
      return nothing;
    }

    return html`
      <wa-details
        id=${ELEMENT_IDS.PLAN_VIEW_CONTAINER}
        class="panel-collapsible is-boxed"
        summary="Plan"
        ?open=${this.open}
        @wa-show=${this.handleShow}
        @wa-hide=${this.handleHide}
      >
        <div class="plan-body">${this.renderDocument(this.plan.objective)}</div>
      </wa-details>
    `;
  }

  /** Kept to one line so the pre-wrap body gets no template whitespace. */
  private renderDocument(text: string): TemplateResult {
    // prettier-ignore
    return html`<div id=${ELEMENT_IDS.PLAN_VIEW} class="plan-document">${text}</div>`;
  }

  private handleShow(e: Event): void {
    if (e.target !== e.currentTarget) return;
    this.open = true;
  }

  private handleHide(e: Event): void {
    if (e.target !== e.currentTarget) return;
    this.open = false;
  }
}
