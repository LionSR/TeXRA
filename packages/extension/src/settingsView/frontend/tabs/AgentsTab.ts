/**
 * The Agents page, one section at a time: the agent library, the team cards
 * (slot `teams`) and skills (slot `skills`) the settings app composes in, and
 * Advanced, the session and team-coordination knobs.
 */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles

// Local imports - shared schemas
import {
  GlobalStateKey,
  WorkspaceStateKey,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  type AgentScanIssue,
} from '@texra-ai/harness/schemas';
import { pluralize } from '@texra-ai/harness/transcript';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { postMessage } from '@texra/shared/hostBridge';
import type { AgentSelectionItem } from '@texra/shared/settingsView/settingsViewMessages';
import type { SettingsSectionName } from '@texra/shared/settingsView/settingsTarget';
import {
  commonViewStyles,
  designTokens,
  settingsBannerStyles,
} from '@ui/styles';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { renderSettingsBanner } from '@ui/wa/settingsBanner';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import {
  renderStateSettingNumberRow,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';

// Local imports - settings view components (side-effect: register)
import '../components/profile/AgentSelectionPanel';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

@customElement('agents-tab')
export class AgentsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    settingsBannerStyles,
    css`
      :host {
        display: block;
      }

      /* max-width and centering provided by .tab-content-container */

      .agents-dir-path {
        font-family: var(--wa-font-family-mono, monospace), monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }

      .custom-agent-issues-banner {
        margin-top: var(--wa-space-m);
      }

      .custom-agent-issues {
        margin: var(--wa-space-s) 0 0;
        padding-left: 1.2em;
      }

      .custom-agent-issues li + li {
        margin-top: var(--wa-space-2xs);
      }

      .agent-folder {
        display: block;
        margin-block-start: var(--wa-space-s);
      }

      ::slotted([slot='teams']),
      ::slotted([slot='skills']) {
        display: block;
      }
    `,
  ];

  @property({ attribute: false }) agents: readonly AgentSelectionItem[] = [];
  @property({ attribute: false }) customAgentDir = '';
  @property({ attribute: false }) customAgentDirIsDefault = true;
  @property({ attribute: false })
  customAgentScanIssues: readonly AgentScanIssue[] = [];
  @property({ attribute: false }) section: SettingsSectionName<'agents'> =
    'library';
  @property({ attribute: false }) compactionThresholdPercent =
    MODEL_COMPACTION_THRESHOLD_SETTING.defaultValue;
  /** Parent-owned acknowledgement generation; a change repaints the number
   *  rows' saved values even when all field values are unchanged. */
  @property({ attribute: false }) ackGeneration = 0;
  @property({ attribute: false }) modelRetryMaxAttempts =
    MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue;
  @property({ attribute: false }) allowOrchestratorKill = true;
  @property({ attribute: false }) detachSubagentsOnStop = false;
  @property({ attribute: false }) worktreeSupport = false;
  @property({ attribute: false }) childRunConcurrencyBudget =
    CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue;

  private handleOpenFolder(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER);
  }

  private handleCreateAgent(task: boolean): void {
    postMessage(SETTINGS_VIEW_COMMANDS.CREATE_AGENT, { task });
  }

  private handleChangeCustomDir(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR);
  }

  private handleResetCustomDir(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR);
  }

  private renderCustomAgentIssues(): TemplateResult | typeof nothing {
    const issues = this.customAgentScanIssues;
    if (issues.length === 0) return nothing;
    return renderSettingsBanner({
      id: 'custom-agent-scan-issues',
      className: 'custom-agent-issues-banner',
      variant: 'warning',
      icon: 'triangle-exclamation',
      title: `${issues.length} custom ${pluralize(issues.length, 'agent')} could not be loaded`,
      description:
        'TeXRA skipped these files in your custom agents folder. Each entry gives the reason.',
      detail: html`
        <ul class="custom-agent-issues">
          ${issues.map(
            (issue) =>
              html`<li>
                <bdi dir="auto"><code>${issue.path}</code></bdi> —
                <bdi dir="auto">${issue.message}</bdi>
              </li>`,
          )}
        </ul>
      `,
    });
  }

  private renderAgentList(): TemplateResult {
    return html`
      <agent-selection-panel .agents=${this.agents}>
        <wa-dropdown slot="actions">
          <wa-button slot="trigger" variant="brand" size="s">
            ${waIcon('plus', { slot: 'start' })}New agent
          </wa-button>
          <wa-dropdown-item @click=${() => this.handleCreateAgent(false)}>
            ${waIcon('comment', { slot: 'icon' })}Chat agent
          </wa-dropdown-item>
          <wa-dropdown-item @click=${() => this.handleCreateAgent(true)}>
            ${waIcon('file-lines', { slot: 'icon' })}Document task agent
          </wa-dropdown-item>
        </wa-dropdown>
      </agent-selection-panel>
    `;
  }

  private renderSection(): TemplateResult {
    switch (this.section) {
      case 'library':
        return this.renderLibrary();
      case 'teams':
        return html`<slot name="teams"></slot>`;
      case 'skills':
        return html`<slot name="skills"></slot>`;
      case 'advanced':
        return this.renderAdvanced();
    }
  }

  override render(): TemplateResult {
    return html`
      <div class="agents-container tab-content-container">
        ${this.renderSection()}
      </div>
    `;
  }

  private renderLibrary(): TemplateResult {
    return html`
      ${this.renderAgentList()} ${this.renderCustomAgentIssues()}
      <wa-details
        class="collapsible-quiet agent-folder"
        summary="Custom agent folder"
      >
        <div class="settings-section">
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-label">
                ${waIcon('folder')} Custom agents
                ${
                  this.customAgentDirIsDefault
                    ? html`<wa-tag variant="neutral" size="s">Default</wa-tag>`
                    : nothing
                }
              </span>
              <span
                class="settings-row-help agents-dir-path"
                title=${this.customAgentDir}
              >
                <bdi dir="auto">${this.customAgentDir}</bdi>
              </span>
            </div>
            <div class="settings-row-control action-button-group">
              ${renderIconActionButton({
                icon: 'folder-open',
                label: 'Open custom agents folder',
                onClick: () => this.handleOpenFolder(),
              })}
              ${renderLabeledActionButton({
                text: 'Change folder',
                label: 'Change custom agents folder',
                kind: 'secondary',
                appearance: 'outlined',
                onClick: () => this.handleChangeCustomDir(),
              })}
              ${
                this.customAgentDirIsDefault
                  ? nothing
                  : renderLabeledActionButton({
                      icon: 'arrow-rotate-left',
                      text: 'Use default folder',
                      label: 'Reset custom agents folder',
                      kind: 'secondary',
                      appearance: 'outlined',
                      onClick: () => this.handleResetCustomDir(),
                    })
              }
            </div>
          </div>
        </div>
      </wa-details>
    `;
  }

  private renderAdvanced(): TemplateResult {
    return html`
      <div class="settings-section">
        ${renderStateSettingNumberRow({
          key: MODEL_COMPACTION_THRESHOLD_SETTING.configKey,
          value: this.compactionThresholdPercent,
          min: MODEL_COMPACTION_THRESHOLD_SETTING.min,
          max: MODEL_COMPACTION_THRESHOLD_SETTING.max,
          unit: '%',
          ackGeneration: this.ackGeneration,
          // Clearing the field commits 0, which is the documented way to
          // disable compaction — not a no-op edit to be reverted.
          revertOnEmpty: false,
        })}
        ${renderStateSettingNumberRow({
          key: MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
          value: this.modelRetryMaxAttempts,
          min: MODEL_RETRY_MAX_ATTEMPTS_SETTING.min,
          max: MODEL_RETRY_MAX_ATTEMPTS_SETTING.max,
          step: 1,
          ackGeneration: this.ackGeneration,
          revertOnEmpty: false,
        })}
        ${renderStateSettingToggleRow({
          key: GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
          checked: this.allowOrchestratorKill,
        })}
        ${renderStateSettingToggleRow({
          key: GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
          checked: this.detachSubagentsOnStop,
        })}
        ${renderStateSettingToggleRow({
          key: WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
          checked: this.worktreeSupport,
        })}
        ${renderStateSettingNumberRow({
          key: CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
          value: this.childRunConcurrencyBudget,
          min: CHILD_RUN_CONCURRENCY_BUDGET_SETTING.min,
          max: CHILD_RUN_CONCURRENCY_BUDGET_SETTING.max,
          step: 1,
          ackGeneration: this.ackGeneration,
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agents-tab': AgentsTab;
  }
}
