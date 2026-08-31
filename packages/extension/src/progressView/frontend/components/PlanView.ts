/**
 * PlanView component - renders the plan as a plain objective document
 * inside a collapsible panel. Step tracking lives in the todo tool.
 */

// Third-party imports
import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import type { Plan } from '@shared/schemas';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Local imports - base class
import { CollapsiblePanel } from './CollapsiblePanel';

@customElement('plan-view')
export class PlanView extends CollapsiblePanel {
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

  @property({ attribute: false }) plan: Plan | null = null;

  override render(): TemplateResult | typeof nothing {
    if (!this.plan) {
      return nothing;
    }

    return this.renderCollapsibleDetails({
      id: ELEMENT_IDS.PLAN_VIEW_CONTAINER,
      summary: 'Plan',
      // Kept to one line so the pre-wrap document gets no template whitespace.
      // prettier-ignore
      body: html`<div class="plan-body"><div id=${ELEMENT_IDS.PLAN_VIEW} class="plan-document">${this.plan.objective}</div></div>`,
    });
  }
}
