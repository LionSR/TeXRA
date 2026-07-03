/** Plan approval request panel. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';

// Local imports - shared utilities
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

// Local imports - base class
import { BaseFeedbackPanel } from './BaseFeedbackPanel';

@customElement('plan-approval-request-panel')
export class PlanApprovalRequestPanel extends BaseFeedbackPanel<'planApproval'> {
  static override styles = [designTokens, commonViewStyles, requestPanelStyles];

  protected override handleExtraKey(key: string): boolean {
    if (key === 'r') {
      const data = this.permission.data;
      if (data.goalEnabled) {
        this.emitAction('approve_and_goal');
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
      details: this.renderObjective(plan.objective),
      approveTitle: 'Approve this plan (y)',
      rejectTitle: 'Reject this plan (n)',
      middleActions: goalEnabled
        ? renderLabeledActionButton({
            icon: 'rocket',
            text: 'Approve & Run',
            title: 'Approve and run this plan autonomously via goal mode (r)',
            action: 'approve_and_goal',
            onClick: () => this.emitAction('approve_and_goal'),
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
