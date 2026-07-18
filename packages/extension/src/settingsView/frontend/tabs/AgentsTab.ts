/** Split panel browser for all agents (local + remote). */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
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
import {
  commonViewStyles,
  designTokens,
  waTabThemeTokenStyles,
} from '@shared/styles';

// Local imports - shared schemas
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { AgentCategory } from '@shared/schemas/agent';
import type { AgentSelectionItem } from '@shared/schemas/settingsViewMessages';
import { isKnownUnsupported } from '@shared/utils/dispatcher';
import type { WaTabShowEvent } from '@shared/wa/tabs';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - settings view components (side-effect: register)
import '../components/profile/AgentSelectionPanel';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

const AGENT_SUB_TAB_PANELS = [
  'workflow',
  'toolUse',
] as const satisfies readonly AgentCategory[];

@customElement('agents-tab')
export class AgentsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      /* max-width and centering provided by .tab-content-container */

      /* Row 1: sub-tabs + New Agent button */
      .agents-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--wa-space-xs);
      }

      /*
       * Sub-tabs use the native wa-tab-group; we hide the body part since
       * the tab content (agent-selection-panel) is rendered separately
       * below, driven by the activeSubTab state.
       */
      wa-tab-group.agents-sub-tabs {
        ${waTabThemeTokenStyles}
      }

      wa-tab-group.agents-sub-tabs::part(body) {
        display: none;
      }

      wa-tab-group.agents-sub-tabs wa-tab {
        font-size: var(--font-size-sm);
      }

      wa-tab-group.agents-sub-tabs wa-tab::part(base) {
        padding-block: var(--wa-space-xs);
        padding-inline: var(--wa-space-s);
      }

      wa-tab-group.agents-sub-tabs wa-tab[active]::part(base) {
        font-weight: var(--font-weight-medium);
      }

      .agents-sub-tab-count {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        opacity: var(--opacity-normal);
      }

      .agents-header-actions {
        display: flex;
        gap: var(--wa-space-2xs);
      }

      .agents-create-btn::part(base) {
        color: var(--wa-color-text-normal);
        border-color: var(--wa-color-focus);
        font-weight: var(--font-weight-medium);
      }

      /* Row 2: directory info bar */
      .agents-dir-bar {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        margin-bottom: var(--wa-space-xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        background: var(--wa-color-surface-lowered);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
      }

      .agents-dir-bar wa-icon {
        font-size: var(--font-size);
        flex-shrink: 0;
      }

      .agents-dir-label {
        white-space: nowrap;
        flex-shrink: 0;
      }

      .agents-dir-path {
        font-family: var(--wa-font-family-mono, monospace), monospace;
        color: var(--wa-color-text-normal);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }

      wa-tag.agents-dir-default-badge {
        flex-shrink: 0;
      }

      .agents-dir-actions {
        display: flex;
        gap: var(--wa-space-2xs);
        flex-shrink: 0;
        margin-left: auto;
      }
    `,
  ];

  @property({ attribute: false }) workflowAgents: AgentSelectionItem[] = [];
  @property({ attribute: false }) toolUseAgents: AgentSelectionItem[] = [];
  @property({ attribute: false }) customAgentDir = '';
  @property({ attribute: false }) customAgentDirIsDefault = true;
  @property({ attribute: false }) initialSubTab?: AgentCategory;
  @property({ attribute: false }) userTier = 'free';

  /**
   * Commands the active host's registry declares `unsupported(...)`, sent
   * once at webview-ready (see `unsupportedCommands` in
   * `@shared/utils/dispatcher`). `null` before that broadcast arrives —
   * checked via `isKnownUnsupported`, which treats "not yet known" as
   * unsupported so a control never flashes visible then hidden.
   */
  @property({ attribute: false })
  unsupportedCommands: ReadonlySet<string> | null = null;

  @state() private activeSubTab: AgentCategory = 'workflow';

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('initialSubTab') && this.initialSubTab) {
      this.activeSubTab = this.initialSubTab;
    }
  }

  private handleOpenFolder(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER, {
      folderType: 'custom',
    });
  }

  private handleCreateAgent(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.CREATE_AGENT, {
      category: this.activeSubTab,
    });
  }

  private handleCreateFromTemplate(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.CREATE_AGENT, {
      category: this.activeSubTab,
      mode: 'template',
    });
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

  private handleSubTabShow = (event: WaTabShowEvent): void => {
    const next = event.detail.name;
    if ((AGENT_SUB_TAB_PANELS as readonly string[]).includes(next)) {
      this.activeSubTab = next as AgentCategory;
    }
  };

  override render(): TemplateResult {
    const activeAgents =
      this.activeSubTab === 'workflow'
        ? this.workflowAgents
        : this.toolUseAgents;

    return html`
      <div class="agents-container tab-content-container">
        <!-- Row 1: Sub-tabs + New Agent -->
        <div class="agents-header">
          <wa-tab-group
            class="agents-sub-tabs"
            .active=${this.activeSubTab}
            @wa-tab-show=${this.handleSubTabShow}
          >
            <wa-tab panel="workflow">
              ${waIcon('symbol-method')} Workflow
              <span class="agents-sub-tab-count"
                >(${this.workflowAgents.length})</span
              >
            </wa-tab>
            <wa-tab panel="toolUse">
              ${waIcon('tools')} Tool Use
              <span class="agents-sub-tab-count"
                >(${this.toolUseAgents.length})</span
              >
            </wa-tab>
          </wa-tab-group>
          <div class="agents-header-actions">
            <wa-button
              appearance="outlined"
              variant="neutral"
              size="small"
              title="Save current agent configuration as a team"
              @click=${this.handleSaveTeam}
            >
              ${waIcon('save', { slot: 'start' })} Save Team
            </wa-button>
            ${
              isKnownUnsupported(
                this.unsupportedCommands,
                SETTINGS_VIEW_COMMANDS.CREATE_AGENT,
              )
                ? nothing
                : html`
                    <wa-button
                      appearance="outlined"
                      variant="neutral"
                      size="small"
                      title="Create a new agent from a blank YAML template"
                      @click=${this.handleCreateFromTemplate}
                    >
                      ${waIcon('new-file', { slot: 'start' })} From Template
                    </wa-button>
                    <wa-button
                      class="agents-create-btn"
                      appearance="outlined"
                      variant="neutral"
                      size="small"
                      title="Create a new agent with AI"
                      @click=${this.handleCreateAgent}
                    >
                      ${waIcon('add', { slot: 'start' })} New Agent
                    </wa-button>
                  `
            }
          </div>
        </div>

        <!-- Row 2: Custom directory info bar -->
        <div class="agents-dir-bar">
          ${waIcon('folder')}
          <span class="agents-dir-label">Custom agents:</span>
          <span class="agents-dir-path" title=${this.customAgentDir}
            >${this.customAgentDir}</span
          >
          ${
            this.customAgentDirIsDefault
              ? html`<wa-tag
                  class="agents-dir-default-badge"
                  variant="neutral"
                  size="small"
                  >default</wa-tag
                >`
              : nothing
          }
          <div class="agents-dir-actions">
            <wa-button
              class="action-icon-button"
              appearance="plain"
              variant="neutral"
              size="small"
              @click=${this.handleOpenFolder}
              title="Open folder in file explorer"
              aria-label="Open folder in file explorer"
            >
              ${waIcon('folder-opened')}
            </wa-button>
            <wa-button
              appearance="outlined"
              variant="neutral"
              size="small"
              title="Change custom agents directory"
              @click=${this.handleChangeCustomDir}
            >
              Change
            </wa-button>
            ${
              !this.customAgentDirIsDefault
                ? html`<wa-button
                    appearance="outlined"
                    variant="neutral"
                    size="small"
                    title="Reset to default directory"
                    @click=${this.handleResetCustomDir}
                  >
                    Reset
                  </wa-button>`
                : nothing
            }
          </div>
        </div>

        <agent-selection-panel
          .agents=${activeAgents}
          .category=${this.activeSubTab}
          .userTier=${this.userTier}
          .unsupportedCommands=${this.unsupportedCommands}
        ></agent-selection-panel>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agents-tab': AgentsTab;
  }
}
