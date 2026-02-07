/**
 * AgentsTab component - split panel browser for all agents (local + remote).
 * Sub-tabs for Workflow and Tool Use categories.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import type { AgentSelectionItem } from '@shared/schemas/settingsViewMessages';

// Local imports - settings view components (side-effect: register)
import '../components/profile/AgentSelectionPanel';

type AgentSubTab = 'workflow' | 'toolUse';

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

      .agents-sub-tabs {
        display: flex;
        gap: 0;
        margin-bottom: var(--spacing-large);
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
    `,
  ];

  @property({ attribute: false }) workflowAgents: AgentSelectionItem[] = [];
  @property({ attribute: false }) toolUseAgents: AgentSelectionItem[] = [];

  @state() private activeSubTab: AgentSubTab = 'workflow';

  private setSubTab(tab: AgentSubTab): void {
    this.activeSubTab = tab;
  }

  override render(): TemplateResult {
    const activeAgents =
      this.activeSubTab === 'workflow'
        ? this.workflowAgents
        : this.toolUseAgents;

    return html`
      <div class="agents-container">
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

        <agent-selection-panel .agents=${activeAgents}></agent-selection-panel>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agents-tab': AgentsTab;
  }
}
