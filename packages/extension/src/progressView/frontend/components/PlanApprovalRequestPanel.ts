/** Plan approval request panel. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';

// Local imports - shared schemas
import type { PlanApprovalPermission } from '@shared/schemas';

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

// Local imports - base class
import { BaseFeedbackPanel } from './BaseFeedbackPanel';

@customElement('plan-approval-request-panel')
export class PlanApprovalRequestPanel extends BaseFeedbackPanel {
  static override styles = [designTokens, commonViewStyles, requestPanelStyles];

  protected override handleExtraKey(key: string): boolean {
    if (key === 'r') {
      const data = this.permission.data as PlanApprovalPermission;
      if (data.goalEnabled) {
        this.emitAction('approve_and_goal');
        return true;
      }
    }
    return false;
  }

  override render(): TemplateResult {
    const data = this.permission.data as PlanApprovalPermission;
    const { plan, goalEnabled } = data;

    return this.renderRequestShell({
      prefix: 'plan-approval-request',
      details: html`
        <div class="plan-approval-request__summary">${plan.summary}</div>
        <ol class="plan-approval-request__steps">
          ${repeat(
            plan.steps,
            (_step, index) => index,
            (step) => html`
              <li>
                <strong>${step.title}</strong>
                ${step.description
                  ? html`<span class="plan-approval-request__step-desc">
                      — ${step.description}</span
                    >`
                  : nothing}
                ${step.files.length > 0
                  ? html`<div class="plan-approval-request__step-files">
                      ${repeat(
                        step.files,
                        (f) => f,
                        (f, i) =>
                          html`${i > 0 ? ', ' : ''}<span
                              class="plan-approval-request__file"
                              title=${f}
                              >${getBasename(f)}</span
                            >`,
                      )}
                    </div>`
                  : nothing}
              </li>
            `,
          )}
        </ol>
      `,
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
}

declare global {
  interface HTMLElementTagNameMap {
    'plan-approval-request-panel': PlanApprovalRequestPanel;
  }
}
