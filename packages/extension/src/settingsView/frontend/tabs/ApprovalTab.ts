/**
 * General › Approval: when agents pause for approval before acting, the
 * working-directory path protection, and the goal spend cap. The task-start
 * policy a task begins under; a grant made on a request card lasts for that
 * task only and is not set here.
 */

import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import {
  WorkspaceStateKey,
  BASH_APPROVAL_CONFIG_KEY,
  GOAL_MAX_COST_SETTING,
  RESUME_ON_OPEN_SETTING,
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
  parseApprovalPolicy,
  APPROVAL_POLICY_CONFIG_KEY,
  type ApprovalPolicy,
} from '@texra-ai/harness/schemas';
import { APPROVAL_POLICY_OPTIONS } from '@ui/copy/approvalPolicy';
import { commonViewStyles, designTokens } from '@ui/styles';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';
import { readSelectValue } from '@ui/wa/selectTemplates';

import {
  postStateSetting,
  renderStateSettingNumberRow,
  renderStateSettingSelectRow,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';
import { settingSignal } from '../settingsState';

@customElement('approval-tab')
export class ApprovalTab extends SignalWatcher(LitElement) {
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

  private handleApprovalPolicyChange = (e: Event): void => {
    const policy = parseApprovalPolicy(readSelectValue(e));
    if (policy) postStateSetting(APPROVAL_POLICY_CONFIG_KEY, policy);
  };

  override render(): TemplateResult {
    const policy = settingSignal<ApprovalPolicy>(
      APPROVAL_POLICY_CONFIG_KEY,
    ).get();
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
                value=${policy}
                @change=${this.handleApprovalPolicyChange}
              >
                ${APPROVAL_POLICY_OPTIONS.map(
                  (option) => html`
                    <wa-radio appearance="button" value=${option.value}
                      >${option.label}</wa-radio
                    >
                  `,
                )}
              </wa-radio-group>
              <p class="settings-row-help">
                ${
                  APPROVAL_POLICY_OPTIONS.find(
                    (option) => option.value === policy,
                  )?.description
                }
              </p>
            </div>
            ${
              // The two switches refine Ask only (decideApproval ignores
              // them under Never and Auto-approve), so they show only then.
              policy === 'ask'
                ? html`
                    ${renderStateSettingToggleRow(TOOL_EDIT_APPROVAL_CONFIG_KEY)}
                    ${renderStateSettingToggleRow(BASH_APPROVAL_CONFIG_KEY)}
                  `
                : nothing
            }
            ${renderStateSettingToggleRow(
              WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
            )}
            ${renderStateSettingNumberRow(GOAL_MAX_COST_SETTING.configKey, {
              min: GOAL_MAX_COST_SETTING.min,
              max: GOAL_MAX_COST_SETTING.max,
              step: 0.5,
            })}
            ${renderStateSettingSelectRow(RESUME_ON_OPEN_SETTING.configKey)}
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
