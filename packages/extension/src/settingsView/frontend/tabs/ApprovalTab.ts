/**
 * General › Approval: when agents pause for approval before acting, the
 * working-directory path protection, and the goal spend cap. The task-start
 * policy a task begins under; a grant made on a request card lasts for that
 * task only and is not set here.
 */

import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import {
  parseTexraApprovalPolicy,
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_OPTIONS,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  BASH_APPROVAL_CONFIG_KEY,
  GOAL_MAX_COST_SETTING,
  RESUME_ON_OPEN_SETTING,
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { commonViewStyles, designTokens } from '@ui/styles';
import {
  renderSettingsNumberRow,
  renderSettingsSectionHeading,
} from '@ui/wa/settingsSection';
import { readSelectValue } from '@ui/wa/selectTemplates';

import {
  postStateSetting,
  renderStateSettingSelectRow,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';

@customElement('approval-tab')
export class ApprovalTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .setting-block {
        margin-bottom: var(--wa-space-2xs);
      }
    `,
  ];

  @property({ type: String }) approvalPolicy: TexraApprovalPolicy = 'ask';
  @property({ type: Boolean }) bashApprovalEnabled = true;
  @property({ type: Boolean }) editApprovalEnabled = true;
  @property({ type: Boolean }) toolPathProtectionEnabled = true;
  @property({ type: Number }) goalMaxCostUsd =
    GOAL_MAX_COST_SETTING.defaultValue;
  @property({ type: String }) resumeOnOpen: string =
    RESUME_ON_OPEN_SETTING.defaultValue;

  private handleApprovalPolicyChange = (e: Event): void => {
    const policy = parseTexraApprovalPolicy(readSelectValue(e));
    if (policy) postStateSetting(TEXRA_APPROVAL_POLICY_CONFIG_KEY, policy);
  };

  override render(): TemplateResult {
    return html`
      <div class="tab-content-container">
        <div class="category-section">
          ${renderSettingsSectionHeading({
            icon: 'shield',
            title: 'Approval & safety',
            description: 'Choose when agents pause for approval before acting.',
          })}
          <div class="settings-section">
            <div class="setting-block">
              <!-- Three choices, all visible: the one control that decides how
                much the user stays in the loop is not hidden in a dropdown. -->
              <wa-radio-group
                id="texra-approval-policy"
                label="Approval policy"
                orientation="horizontal"
                value=${this.approvalPolicy}
                @change=${this.handleApprovalPolicyChange}
              >
                ${TEXRA_APPROVAL_POLICY_OPTIONS.map(
                  (option) => html`
                    <wa-radio appearance="button" value=${option.value}
                      >${option.label}</wa-radio
                    >
                  `,
                )}
              </wa-radio-group>
              <p class="settings-row-help">
                ${
                  TEXRA_APPROVAL_POLICY_OPTIONS.find(
                    (option) => option.value === this.approvalPolicy,
                  )?.description
                }
              </p>
            </div>
            ${
              // The two switches refine Ask only (decideTexraApproval ignores
              // them under Never and Auto-approve), so they show only then.
              this.approvalPolicy === 'ask'
                ? html`
                    ${renderStateSettingToggleRow({
                      key: TOOL_EDIT_APPROVAL_CONFIG_KEY,
                      checked: this.editApprovalEnabled,
                    })}
                    ${renderStateSettingToggleRow({
                      key: BASH_APPROVAL_CONFIG_KEY,
                      checked: this.bashApprovalEnabled,
                    })}
                  `
                : nothing
            }
            ${renderStateSettingToggleRow({
              key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
              checked: this.toolPathProtectionEnabled,
            })}
            ${renderSettingsNumberRow({
              label: 'Goal spend cap (USD)',
              description: GOAL_MAX_COST_SETTING.description,
              value: this.goalMaxCostUsd,
              min: GOAL_MAX_COST_SETTING.min,
              max: GOAL_MAX_COST_SETTING.max,
              step: 0.5,
              onChange: (value) =>
                postStateSetting(GOAL_MAX_COST_SETTING.configKey, value),
            })}
            ${renderStateSettingSelectRow({
              key: RESUME_ON_OPEN_SETTING.configKey,
              value: this.resumeOnOpen,
            })}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'approval-tab': ApprovalTab;
  }
}
