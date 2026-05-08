/**
 * AgentsTab component - split panel browser for all agents (local + remote).
 * Sub-tabs for Workflow and Tool Use categories.
 */

// Third-party imports
import '@awesome.me/webawesome/dist/components/tag/tag.js';
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
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import type { AgentCategory } from '@shared/schemas/agent';
import type { AgentSelectionItem } from '@shared/schemas/settingsViewMessages';
import { AgentSelectionEvents } from '../components/profile/events';

// Local imports - settings view components (side-effect: register)
import '../components/profile/AgentSelectionPanel';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

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

      .agents-sub-tabs {
        display: flex;
        gap: 0;
        border-bottom: var(--border-thin) solid var(--color-border);
      }

      .agents-sub-tab {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-xs) var(--wa-space-s);
        font-size: var(--font-size-sm);
        font-family: inherit;
        color: var(--color-text-secondary);
        background: none;
        border: none;
        border-bottom: var(--border-medium) solid transparent;
        cursor: pointer;
        transition:
          color var(--transition-fast),
          border-color var(--transition-fast);
      }

      .agents-sub-tab:hover {
        color: var(--texra-foreground);
      }

      .agents-sub-tab:focus-visible {
        outline: var(--border-thin) solid var(--texra-focusBorder);
        outline-offset: 1px;
        border-radius: var(--border-radius-small);
      }

      .agents-sub-tab.active {
        color: var(--texra-foreground);
        border-bottom-color: var(--texra-focusBorder);
        font-weight: var(--font-weight-medium);
      }

      .agents-sub-tab-count {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        opacity: var(--opacity-normal);
      }

      /* Base styles provided by .tab-action-btn in commonViewStyles */

      .agents-header-actions {
        display: flex;
        gap: var(--wa-space-2xs);
      }

      .agents-create-btn {
        color: var(--texra-foreground);
        border-color: var(--texra-focusBorder);
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
        background: var(--texra-sideBar-background, rgba(128, 128, 128, 0.04));
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
        font-family: var(--texra-editor-font-family, monospace), monospace;
        color: var(--texra-foreground);
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

      .agents-dir-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: var(--wa-space-3xs);
        color: var(--color-text-secondary);
        background: none;
        border: none;
        border-radius: var(--border-radius);
        cursor: pointer;
        transition: color var(--transition-fast);
      }

      .agents-dir-icon-btn:hover {
        color: var(--texra-foreground);
      }

      .agents-dir-icon-btn:focus-visible {
        outline: var(--border-thin) solid var(--texra-focusBorder);
        outline-offset: 1px;
        border-radius: var(--border-radius-small);
      }
    `,
  ];

  @property({ attribute: false }) workflowAgents: AgentSelectionItem[] = [];
  @property({ attribute: false }) toolUseAgents: AgentSelectionItem[] = [];
  @property({ attribute: false }) customAgentDir = '';
  @property({ attribute: false }) customAgentDirIsDefault = true;
  @property({ attribute: false }) initialSubTab?: AgentCategory;
  @property({ attribute: false }) userTier = 'free';
  @property({ type: Boolean, attribute: 'desktop-host' }) desktopHost = false;

  @state() private activeSubTab: AgentCategory = 'workflow';

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('initialSubTab') && this.initialSubTab) {
      this.activeSubTab = this.initialSubTab;
    }
  }

  private handleOpenFolder(): void {
    this.dispatchEvent(
      AgentSelectionEvents.openFolder({ folderType: 'custom' }),
    );
  }

  private handleCreateAgent(): void {
    this.dispatchEvent(
      AgentSelectionEvents.createAgent({ category: this.activeSubTab }),
    );
  }

  private handleCreateFromTemplate(): void {
    this.dispatchEvent(
      AgentSelectionEvents.createAgent({
        category: this.activeSubTab,
        mode: 'template',
      }),
    );
  }

  private handleChangeCustomDir(): void {
    this.dispatchEvent(AgentSelectionEvents.setCustomDir());
  }

  private handleResetCustomDir(): void {
    this.dispatchEvent(AgentSelectionEvents.resetCustomDir());
  }

  private handleSaveTeam(): void {
    this.dispatchEvent(AgentSelectionEvents.saveTeam());
  }

  override render(): TemplateResult {
    const activeAgents =
      this.activeSubTab === 'workflow'
        ? this.workflowAgents
        : this.toolUseAgents;

    return html`
      <div class="agents-container tab-content-container">
        <!-- Row 1: Sub-tabs + New Agent -->
        <div class="agents-header">
          <div class="agents-sub-tabs">
            <button
              class="agents-sub-tab ${this.activeSubTab === 'workflow'
                ? 'active'
                : ''}"
              @click=${() => (this.activeSubTab = 'workflow')}
            >
              <wa-icon library="texra" name="symbol-method"></wa-icon>
              Workflow
              <span class="agents-sub-tab-count"
                >(${this.workflowAgents.length})</span
              >
            </button>
            <button
              class="agents-sub-tab ${this.activeSubTab === 'toolUse'
                ? 'active'
                : ''}"
              @click=${() => (this.activeSubTab = 'toolUse')}
            >
              <wa-icon library="texra" name="tools"></wa-icon>
              Tool Use
              <span class="agents-sub-tab-count"
                >(${this.toolUseAgents.length})</span
              >
            </button>
          </div>
          <div class="agents-header-actions">
            <button
              class="tab-action-btn"
              @click=${this.handleSaveTeam}
              title="Save current agent configuration as a team"
            >
              <wa-icon library="texra" name="save"></wa-icon>
              Save Team
            </button>
            ${this.desktopHost
              ? nothing
              : html`
                  <button
                    class="tab-action-btn"
                    @click=${this.handleCreateFromTemplate}
                    title="Create a new agent from a blank YAML template"
                  >
                    <wa-icon library="texra" name="new-file"></wa-icon>
                    From Template
                  </button>
                  <button
                    class="tab-action-btn agents-create-btn"
                    @click=${this.handleCreateAgent}
                    title="Create a new agent with AI"
                  >
                    <wa-icon library="texra" name="add"></wa-icon>
                    New Agent
                  </button>
                `}
          </div>
        </div>

        <!-- Row 2: Custom directory info bar -->
        <div class="agents-dir-bar">
          <wa-icon library="texra" name="folder"></wa-icon>
          <span class="agents-dir-label">Custom agents:</span>
          <span class="agents-dir-path" title=${this.customAgentDir}
            >${this.customAgentDir}</span
          >
          ${this.customAgentDirIsDefault
            ? html`<wa-tag
                class="agents-dir-default-badge"
                variant="neutral"
                size="small"
                >default</wa-tag
              >`
            : nothing}
          <div class="agents-dir-actions">
            <button
              class="agents-dir-icon-btn"
              @click=${this.handleOpenFolder}
              title="Open folder in file explorer"
            >
              <wa-icon library="texra" name="folder-opened"></wa-icon>
            </button>
            <button
              class="tab-action-btn"
              @click=${this.handleChangeCustomDir}
              title="Change custom agents directory"
            >
              Change
            </button>
            ${!this.customAgentDirIsDefault
              ? html`<button
                  class="tab-action-btn"
                  @click=${this.handleResetCustomDir}
                  title="Reset to default directory"
                >
                  Reset
                </button>`
              : nothing}
          </div>
        </div>

        <agent-selection-panel
          .agents=${activeAgents}
          .category=${this.activeSubTab}
          .userTier=${this.userTier}
          .desktopHost=${this.desktopHost}
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
