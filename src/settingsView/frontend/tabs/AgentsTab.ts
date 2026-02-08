/**
 * AgentsTab component - split panel browser for all agents (local + remote).
 * Sub-tabs for Workflow and Tool Use categories.
 */

// Third-party imports
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
import { codiconStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - events
import { AgentSelectionEvents } from '../components/profile/events';

// Local imports - shared schemas
import type { AgentCategory } from '@shared/schemas/agent';
import type { AgentSelectionItem } from '@shared/schemas/settingsViewMessages';

// Local imports - settings view components (side-effect: register)
import '../components/profile/AgentSelectionPanel';

@customElement('agents-tab')
export class AgentsTab extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .agents-container {
        max-width: 1000px;
        margin: 0 auto;
      }

      /* Row 1: sub-tabs + New Agent button */
      .agents-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-medium);
      }

      .agents-sub-tabs {
        display: flex;
        gap: 0;
        border-bottom: var(--border-thin) solid var(--color-border);
      }

      .agents-sub-tab {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-medium) var(--spacing-large);
        font-size: var(--font-size-sm);
        font-family: inherit;
        color: var(--color-text-secondary);
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        cursor: pointer;
        transition:
          color 0.15s ease,
          border-color 0.15s ease;
      }

      .agents-sub-tab:hover {
        color: var(--vscode-foreground);
      }

      .agents-sub-tab.active {
        color: var(--vscode-foreground);
        border-bottom-color: var(--vscode-focusBorder);
        font-weight: 500;
      }

      .agents-sub-tab-count {
        font-size: var(--font-size-xs, 11px);
        color: var(--color-text-secondary);
        opacity: 0.8;
      }

      .agents-folder-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: 2px var(--spacing-small);
        font-size: var(--font-size-xs, 11px);
        font-family: inherit;
        color: var(--color-text-secondary);
        background: none;
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        cursor: pointer;
        transition:
          color 0.1s ease,
          border-color 0.1s ease;
      }

      .agents-folder-btn:hover {
        color: var(--vscode-foreground);
        border-color: var(--vscode-focusBorder);
      }

      .agents-create-btn {
        color: var(--vscode-foreground);
        border-color: var(--vscode-focusBorder);
        font-weight: 500;
      }

      /* Row 2: directory info bar */
      .agents-dir-bar {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-small) var(--spacing-medium);
        margin-bottom: var(--spacing-medium);
        font-size: var(--font-size-xs, 11px);
        color: var(--color-text-secondary);
        background: var(--vscode-sideBar-background, rgba(128, 128, 128, 0.04));
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
      }

      .agents-dir-bar .codicon {
        font-size: 14px;
        flex-shrink: 0;
      }

      .agents-dir-label {
        white-space: nowrap;
        flex-shrink: 0;
      }

      .agents-dir-path {
        font-family: var(--vscode-editor-font-family, monospace);
        color: var(--vscode-foreground);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }

      .agents-dir-default-badge {
        flex-shrink: 0;
        padding: 0 4px;
        font-size: 10px;
        color: var(--color-text-secondary);
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.15));
        border-radius: 3px;
      }

      .agents-dir-separator {
        flex-shrink: 0;
        width: 1px;
        height: 14px;
        background: var(--color-border);
        margin: 0 2px;
      }

      .agents-dir-actions {
        display: flex;
        gap: var(--spacing-small);
        flex-shrink: 0;
        margin-left: auto;
      }

      .agents-toggle-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        margin-bottom: var(--spacing-medium);
        font-size: var(--font-size-sm);
        color: var(--vscode-foreground);
      }

      .agents-toggle-row input[type='checkbox'] {
        accent-color: var(--vscode-focusBorder);
        cursor: pointer;
      }

      .agents-toggle-row label {
        cursor: pointer;
      }
    `,
  ];

  @property({ attribute: false }) workflowAgents: AgentSelectionItem[] = [];
  @property({ attribute: false }) toolUseAgents: AgentSelectionItem[] = [];
  @property({ attribute: false }) customAgentDir = '';
  @property({ attribute: false }) customAgentDirIsDefault = true;
  @property({ type: Boolean }) autoShowRemote = true;
  @property({ attribute: false }) initialSubTab?: AgentCategory;

  @state() private activeSubTab: AgentCategory = 'workflow';

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('initialSubTab') && this.initialSubTab) {
      this.activeSubTab = this.initialSubTab;
    }
  }

  private setSubTab(tab: AgentCategory): void {
    this.activeSubTab = tab;
  }

  private handleOpenFolder(
    folderType: 'custom' | 'builtInWorkflow' | 'builtInToolUse',
  ): void {
    this.dispatchEvent(AgentSelectionEvents.openFolder({ folderType }));
  }

  private handleCreateAgent(): void {
    this.dispatchEvent(
      AgentSelectionEvents.createAgent({ category: this.activeSubTab }),
    );
  }

  private handleChangeCustomDir(): void {
    this.dispatchEvent(AgentSelectionEvents.setCustomDir());
  }

  private handleResetCustomDir(): void {
    this.dispatchEvent(AgentSelectionEvents.resetCustomDir());
  }

  private handleToggleAutoShowRemote(): void {
    this.dispatchEvent(
      AgentSelectionEvents.setAutoShowRemote({ enabled: !this.autoShowRemote }),
    );
  }

  override render(): TemplateResult {
    const activeAgents =
      this.activeSubTab === 'workflow'
        ? this.workflowAgents
        : this.toolUseAgents;

    return html`
      <div class="agents-container">
        <!-- Row 1: Sub-tabs + New Agent -->
        <div class="agents-header">
          <div class="agents-sub-tabs">
            <button
              class="agents-sub-tab ${this.activeSubTab === 'workflow'
                ? 'active'
                : ''}"
              @click=${() => this.setSubTab('workflow')}
            >
              <span class="codicon codicon-symbol-method"></span>
              Workflow
              <span class="agents-sub-tab-count"
                >(${this.workflowAgents.length})</span
              >
            </button>
            <button
              class="agents-sub-tab ${this.activeSubTab === 'toolUse'
                ? 'active'
                : ''}"
              @click=${() => this.setSubTab('toolUse')}
            >
              <span class="codicon codicon-tools"></span>
              Tool Use
              <span class="agents-sub-tab-count"
                >(${this.toolUseAgents.length})</span
              >
            </button>
          </div>
          <button
            class="agents-folder-btn agents-create-btn"
            @click=${this.handleCreateAgent}
            title="Create a new agent with AI"
          >
            <span class="codicon codicon-add"></span>
            New Agent
          </button>
        </div>

        <!-- Row 2: Custom directory info bar -->
        <div class="agents-dir-bar">
          <span class="codicon codicon-folder"></span>
          <span class="agents-dir-label">Custom agents:</span>
          <span class="agents-dir-path" title=${this.customAgentDir}
            >${this.customAgentDir}</span
          >
          ${this.customAgentDirIsDefault
            ? html`<span class="agents-dir-default-badge">default</span>`
            : nothing}
          <div class="agents-dir-actions">
            <button
              class="agents-folder-btn"
              @click=${this.handleChangeCustomDir}
              title="Change custom agents directory"
            >
              Change
            </button>
            ${!this.customAgentDirIsDefault
              ? html`<button
                  class="agents-folder-btn"
                  @click=${this.handleResetCustomDir}
                  title="Reset to default directory"
                >
                  Reset
                </button>`
              : nothing}
            <span class="agents-dir-separator"></span>
            <button
              class="agents-folder-btn"
              @click=${() => this.handleOpenFolder('custom')}
              title="Open custom agents folder"
            >
              Open
            </button>
            <button
              class="agents-folder-btn"
              @click=${() => this.handleOpenFolder('builtInWorkflow')}
              title="Open built-in agents folder"
            >
              Built-in
            </button>
            <button
              class="agents-folder-btn"
              @click=${() => this.handleOpenFolder('builtInToolUse')}
              title="Open tool-use agents folder"
            >
              Tool Use
            </button>
          </div>
        </div>

        <div class="agents-toggle-row">
          <input
            type="checkbox"
            id="auto-show-remote"
            .checked=${this.autoShowRemote}
            @change=${this.handleToggleAutoShowRemote}
          />
          <label for="auto-show-remote"
            >Auto-show remote agents in dropdowns</label
          >
        </div>

        <agent-selection-panel
          .agents=${activeAgents}
          .category=${this.activeSubTab}
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
