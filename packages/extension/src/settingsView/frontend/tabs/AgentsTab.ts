/** Split panel browser for all agents (local + remote). */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  settingsBannerStyles,
} from '@shared/styles';

// Local imports - shared schemas
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  type AgentCategory,
  type AgentScanIssue,
  type AgentSelectionItem,
  type ByCategory,
  byCategory,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
} from '@shared/schemas';
import { UnsupportedCommandsMixin } from '@shared/wa/unsupportedCommandsMixin';
import { isKnownUnsupported } from '@shared/utils/dispatcher';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@shared/wa/actionButtons';
import { renderSettingsBanner } from '@shared/wa/settingsBanner';
import {
  renderSettingsNumberRow,
  renderSettingsSectionHeading,
} from '@shared/wa/settingsSection';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { pluralize } from '@utils/text/stringUtils';
import { postStateSetting } from '../components/shared/stateSettingRows';

// Local imports - settings view components (side-effect: register)
import '../components/profile/AgentSelectionPanel';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

@customElement('agents-tab')
export class AgentsTab extends UnsupportedCommandsMixin(LitElement) {
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

      .agent-category + .agent-category,
      .agent-category + .settings-section-heading {
        margin-top: var(--wa-space-l);
      }

      .setting-number-input {
        width: 80px;
      }

      .setting-unit {
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      .agent-category agent-selection-panel {
        display: block;
        min-height: 22rem;
      }
    `,
  ];

  @property({ attribute: false }) agents: ByCategory<AgentSelectionItem[]> =
    byCategory(() => []);
  @property({ attribute: false }) customAgentDir = '';
  @property({ attribute: false }) customAgentDirIsDefault = true;
  @property({ attribute: false }) customAgentScanIssues: AgentScanIssue[] = [];
  @property({ attribute: false }) initialSubTab?: AgentCategory;
  @property({ attribute: false }) compactionThresholdPercent =
    MODEL_COMPACTION_THRESHOLD_SETTING.defaultValue;
  /** Parent-owned acknowledgement generation; changes force a re-render even when all field values are unchanged. */
  @property({ attribute: false }) ackGeneration = 0;
  @property({ attribute: false }) modelRetryMaxAttempts =
    MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue;

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('initialSubTab') && this.initialSubTab) {
      this.shadowRoot
        ?.querySelector(`#${this.initialSubTab}-agents-section`)
        ?.scrollIntoView({ block: 'start' });
    }
  }

  private handleOpenFolder(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER, {
      folderType: 'custom',
    });
  }

  private handleCreateAgent(category: AgentCategory, template = false): void {
    postMessage(
      SETTINGS_VIEW_COMMANDS.CREATE_AGENT,
      template ? { category, mode: 'template' } : { category },
    );
  }

  private handleChangeCustomDir(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR);
  }

  private handleResetCustomDir(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR);
  }

  private handleSaveTeam(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET);
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
        'These files are in the folder above. TeXRA skipped them; each entry below gives the reason.',
      detail: html`
        <ul class="custom-agent-issues">
          ${issues.map(
            (issue) =>
              html`<li><code>${issue.path}</code> — ${issue.message}</li>`,
          )}
        </ul>
      `,
    });
  }

  private renderAgentCategory(
    category: AgentCategory,
    agents: AgentSelectionItem[],
    title: string,
    description: string,
    icon: TeXRAIconName,
  ): TemplateResult {
    const createSupported = !isKnownUnsupported(
      this.unsupportedCommands,
      SETTINGS_VIEW_COMMANDS.CREATE_AGENT,
    );
    const actions = createSupported
      ? html`
          ${renderLabeledActionButton({
            icon: 'file-circle-plus',
            text: 'From template',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: () => this.handleCreateAgent(category, true),
          })}
          ${renderLabeledActionButton({
            icon: 'plus',
            text: 'New agent',
            kind: 'primary',
            appearance: 'filled',
            onClick: () => this.handleCreateAgent(category),
          })}
        `
      : nothing;
    return html`
      <section id="${category}-agents-section" class="agent-category">
        ${renderSettingsSectionHeading({
          title: `${title} (${agents.length})`,
          description,
          icon,
          actions,
        })}
        <agent-selection-panel
          .agents=${agents}
          .category=${category}
          .unsupportedCommands=${this.unsupportedCommands}
        ></agent-selection-panel>
      </section>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div
        class="agents-container tab-content-container"
        data-ack-generation=${this.ackGeneration}
      >
        ${renderSettingsSectionHeading({
          title: 'Agent library',
          description:
            'Configure workflow and tool-use agents, then save the enabled set as a reusable team.',
          icon: 'robot',
          actions: renderLabeledActionButton({
            icon: 'floppy-disk',
            text: 'Save team',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: () => this.handleSaveTeam(),
          }),
        })}
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
                ${this.customAgentDir}
              </span>
            </div>
            <div class="settings-row-control action-button-group">
              ${renderIconActionButton({
                icon: 'folder-open',
                label: 'Open custom agents folder',
                onClick: () => this.handleOpenFolder(),
              })}
              ${renderLabeledActionButton({
                text: 'Change',
                kind: 'secondary',
                appearance: 'outlined',
                onClick: () => this.handleChangeCustomDir(),
              })}
              ${
                this.customAgentDirIsDefault
                  ? nothing
                  : renderLabeledActionButton({
                      icon: 'arrow-rotate-left',
                      text: 'Reset',
                      kind: 'secondary',
                      appearance: 'outlined',
                      onClick: () => this.handleResetCustomDir(),
                    })
              }
            </div>
          </div>
          ${this.renderCustomAgentIssues()}
        </div>
        ${this.renderAgentCategory(
          'toolUse',
          this.agents.toolUse,
          'Tool-use agents',
          'Interactive agents that can inspect files, run tools, and edit the workspace.',
          'screwdriver-wrench',
        )}
        ${this.renderAgentCategory(
          'workflow',
          this.agents.workflow,
          'Workflow agents',
          'Focused specialists for writing, review, research, and structured paper workflows.',
          'wand-magic-sparkles',
        )}
        ${renderSettingsSectionHeading({
          title: 'Reliability',
          description:
            'Tweak how long model sessions handle retries and context limits.',
          icon: 'rotate-right',
        })}
        <div class="settings-section">
          ${renderSettingsNumberRow({
            label: 'Compaction threshold',
            description: MODEL_COMPACTION_THRESHOLD_SETTING.description,
            value: this.compactionThresholdPercent,
            min: MODEL_COMPACTION_THRESHOLD_SETTING.min,
            max: MODEL_COMPACTION_THRESHOLD_SETTING.max,
            unit: '%',
            // Clearing the field commits 0, which is the documented way to
            // disable compaction — not a no-op edit to be reverted.
            revertOnEmpty: false,
            onChange: (value) =>
              postStateSetting(
                MODEL_COMPACTION_THRESHOLD_SETTING.configKey,
                value,
              ),
          })}
          ${renderSettingsNumberRow({
            label: 'Automatic retries',
            description: MODEL_RETRY_MAX_ATTEMPTS_SETTING.description,
            value: this.modelRetryMaxAttempts,
            min: MODEL_RETRY_MAX_ATTEMPTS_SETTING.min,
            max: MODEL_RETRY_MAX_ATTEMPTS_SETTING.max,
            step: 1,
            revertOnEmpty: false,
            onChange: (value) =>
              postStateSetting(
                MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
                value,
              ),
          })}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agents-tab': AgentsTab;
  }
}
