/** Plan approval request panel. */

// Third-party imports
import { css, html, nothing, type CSSResult, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
  sp,
} from '@shared/styles';

// Local imports - shared utilities
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

// Local imports - base class
import { BaseApprovalPanel } from './BaseApprovalPanel';

/**
 * Styles for the plan approval request panel. Kept inline (rather than a
 * sibling `.styles.ts` file) since it is a single ~10-line rule.
 */
const planApprovalRequestPanelStyles: CSSResult = css`
  .plan-approval-request__objective {
    margin: ${sp.small} 0;
    color: var(--wa-color-text-normal);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .plan-approval-request__goal-explanation {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }
`;

@customElement('plan-approval-request-panel')
export class PlanApprovalRequestPanel extends BaseApprovalPanel<'planApproval'> {
  static override styles = [
    designTokens,
    commonViewStyles,
    requestPanelSharedStyles,
    planApprovalRequestPanelStyles,
  ];

  protected readonly approvalDecision = { action: 'approve' } as const;

  protected override handleExtraKey(key: string): boolean {
    if (key === 'r') {
      const data = this.permission.data;
      if (data.goalEnabled) {
        this.emitAction({ action: 'approve_and_goal' });
        return true;
      }
    }
    return false;
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const { plan, goalEnabled } = data;

    return this.renderRequestShell({
      prefix: 'plan-approval-request',
      details: html`
        ${this.renderObjective(plan.objective)}
        ${
          goalEnabled
            ? html`<div class="plan-approval-request__goal-explanation">
                <strong>Run as Goal</strong> keeps the agent working across
                turns until it completes the plan, needs your input, or you stop
                it. Only Bash commands are auto-approved; edits and other
                actions still ask.
              </div>`
            : nothing
        }
      `,
      approveTitle: 'Approve this plan (y)',
      rejectTitle: 'Reject this plan (n)',
      middleActions: goalEnabled
        ? renderLabeledActionButton({
            icon: 'rocket',
            text: 'Run as Goal',
            title:
              'Approve this plan and keep working across turns until it completes or needs your input (r)',
            action: 'approve_and_goal',
            onClick: () => this.emitAction({ action: 'approve_and_goal' }),
          })
        : nothing,
      feedbackPlaceholder: 'Why are you rejecting this plan?',
    });
  }

  /** Kept to one line so the pre-wrap body gets no template whitespace. */
  private renderObjective(text: string): TemplateResult {
    return html`<div class="plan-approval-request__objective">${text}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'plan-approval-request-panel': PlanApprovalRequestPanel;
  }
}
