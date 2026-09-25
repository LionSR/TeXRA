/** Plan request card: "Approve this plan", its objective, Run as Goal. */

// Third-party imports
import { css, html, nothing, type CSSResult, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared styles
import { sp } from '@ui/styles';

// Local imports - shared utilities
import { PLAN_GOAL_COPY } from '@ui/copy/delegationApproval';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

const planApprovalRequestPanelStyles: CSSResult = css`
  :host {
    --request-accent: var(--wa-color-text-link);
  }

  .plan-request__objective {
    margin: ${sp.small} 0;
    color: var(--wa-color-text-normal);
    line-height: var(--line-height-normal);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .plan-request__goal-explanation {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }
`;

@customElement('plan-approval-request-panel')
export class PlanApprovalRequestPanel extends BaseRequestPanel<'planApproval'> {
  static override styles = [
    BaseRequestPanel.styles,
    planApprovalRequestPanelStyles,
  ];

  protected override submitPrimary(): void {
    this.emitAction({ action: 'approve' });
  }

  protected override renderAsk(): string {
    return 'Approve this plan';
  }

  protected override handleExtraKey(key: string): boolean {
    if (key !== 'r' || !this.permission.data.goalEnabled) return false;
    this.emitAction({ action: 'approve_and_goal' });
    return true;
  }

  override render(): TemplateResult {
    const { plan, goalEnabled } = this.permission.data;

    return this.renderCard(
      // Kept to one line so the pre-wrap body gets no template whitespace.
      // prettier-ignore
      html`
        <div class="plan-request__objective" dir="auto">${plan.objective}</div>
        ${
          goalEnabled
            ? html`<div class="plan-request__goal-explanation">
                <strong>${PLAN_GOAL_COPY.action}</strong>
                ${PLAN_GOAL_COPY.progressViewExplanation}
              </div>`
            : nothing
        }
      `,
      goalEnabled
        ? renderLabeledActionButton({
            icon: 'rocket',
            text: PLAN_GOAL_COPY.action,
            title: `${PLAN_GOAL_COPY.action} (r)`,
            action: 'approve_and_goal',
            disabled: this.readOnly,
            onClick: () => this.emitAction({ action: 'approve_and_goal' }),
          })
        : nothing,
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'plan-approval-request-panel': PlanApprovalRequestPanel;
  }
}
