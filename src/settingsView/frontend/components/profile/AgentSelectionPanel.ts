/**
 * AgentSelectionPanel component - split panel with agent list and detail pane.
 * Shows agents for a single category (workflow or tool-use) with a
 * master-detail layout: list on the left, details on the right.
 */

// Third-party imports
import {
  LitElement,
  html,
  nothing,
  css,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas and events
import { AGENT_SOURCE, type AgentCategory } from '@shared/schemas/agent';
import { AgentSelectionEvents } from './events';
import type { AgentSelectionItem } from '@shared/schemas/settingsViewMessages';

/** Unique key for an agent: disambiguates agents with same name across sources */
function agentKey(agent: AgentSelectionItem): string {
  return `${agent.source}:${agent.name}`;
}

/** Source display names for agent origins */
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  [AGENT_SOURCE.BUILT_IN_WORKFLOW]: 'Built-in',
  [AGENT_SOURCE.BUILT_IN_TOOL_USE]: 'Built-in',
  [AGENT_SOURCE.CUSTOM]: 'Custom',
  [AGENT_SOURCE.REMOTE]: 'Remote',
};

@customElement('agent-selection-panel')
export class AgentSelectionPanel extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    css`
      :host {
        display: block;
      }

      .agent-split-panel {
        display: flex;
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        min-height: 300px;
        max-height: 500px;
        overflow: hidden;
      }

      /* --- Left: Agent list --- */
      .agent-list-pane {
        width: 240px;
        min-width: 200px;
        border-right: var(--border-thin) solid var(--color-border);
        overflow-y: auto;
        flex-shrink: 0;
      }

      .agent-list-section-header {
        display: flex;
        align-items: center;
        padding: var(--spacing-small) var(--spacing-medium);
        font-size: var(--font-size-xs, 11px);
        font-weight: 600;
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--vscode-editor-background);
        border-bottom: var(--border-thin) solid var(--color-border);
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .agent-list-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-small) var(--spacing-medium);
        cursor: pointer;
        font-size: var(--font-size-sm);
        color: var(--vscode-foreground);
        border-left: 2px solid transparent;
        transition: background 0.1s ease;
        outline: none;
      }

      .agent-list-item:hover {
        background: var(--vscode-list-hoverBackground);
      }

      .agent-list-item:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .agent-list-item.selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        border-left-color: var(--vscode-focusBorder);
      }

      .agent-list-item-checkbox {
        accent-color: var(--vscode-focusBorder);
        cursor: pointer;
        flex-shrink: 0;
      }

      .agent-list-item-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--vscode-editor-font-family);
      }

      .agent-list-item-badges {
        display: flex;
        gap: 2px;
        font-size: var(--font-size-xs, 11px);
        opacity: 0.8;
        flex-shrink: 0;
      }

      /* --- Right: Detail pane --- */
      .agent-detail-pane {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-large);
        min-width: 0;
      }

      .agent-detail-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-secondary);
        font-style: italic;
      }

      .agent-detail-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
        margin-bottom: var(--spacing-large);
      }

      .agent-detail-name {
        font-size: var(--font-size-lg);
        font-weight: 600;
        font-family: var(--vscode-editor-font-family);
        color: var(--vscode-foreground);
      }

      .agent-detail-description {
        color: var(--vscode-foreground);
        line-height: 1.5;
        margin-bottom: var(--spacing-large);
      }

      .agent-detail-meta {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--spacing-small) var(--spacing-large);
        margin-bottom: var(--spacing-large);
        font-size: var(--font-size-sm);
      }

      .agent-detail-meta-label {
        font-weight: 500;
        color: var(--color-text-secondary);
        white-space: nowrap;
      }

      .agent-detail-meta-value {
        color: var(--vscode-foreground);
      }

      .agent-detail-tools {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-small);
      }

      .agent-tool-badge {
        display: inline-block;
        padding: 1px var(--spacing-small);
        font-size: var(--font-size-xs, 11px);
        font-family: var(--vscode-editor-font-family);
        background: var(--vscode-textBlockQuote-background);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        color: var(--color-text-secondary);
      }

      .agent-detail-actions {
        display: flex;
        gap: var(--spacing-medium);
        flex-wrap: wrap;
      }

      .agent-action-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-small) var(--spacing-medium);
        font-size: var(--font-size-sm);
        font-family: inherit;
        color: var(--vscode-foreground);
        background: var(--vscode-input-background);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        cursor: pointer;
        transition:
          background 0.1s ease,
          border-color 0.1s ease;
      }

      .agent-action-btn:hover {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-focusBorder);
      }

      .agent-count {
        padding: var(--spacing-small) var(--spacing-medium);
        font-size: var(--font-size-xs, 11px);
        color: var(--color-text-secondary);
        border-top: var(--border-thin) solid var(--color-border);
        background: var(--vscode-editor-background);
      }

      .agent-empty-message {
        color: var(--color-text-secondary);
        font-style: italic;
      }
    `,
  ];

  @property({ attribute: false }) agents: AgentSelectionItem[] = [];
  @property({ type: String }) category: AgentCategory = 'workflow';

  @state() private selectedKey: string | null = null;

  /** Cached grouped agents, updated in willUpdate */
  @state() private groupedSources: Map<string, AgentSelectionItem[]> =
    new Map();

  /** Flat list in visual display order (source-grouped), for keyboard navigation */
  private displayOrder: AgentSelectionItem[] = [];

  /** Source display order — must match renderList() */
  private static readonly SOURCE_ORDER = [
    AGENT_SOURCE.CUSTOM,
    AGENT_SOURCE.BUILT_IN_WORKFLOW,
    AGENT_SOURCE.BUILT_IN_TOOL_USE,
    AGENT_SOURCE.REMOTE,
  ];

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('agents')) {
      // Recompute grouped agents
      const groups = new Map<string, AgentSelectionItem[]>();
      for (const agent of this.agents) {
        const list = groups.get(agent.source) ?? [];
        list.push(agent);
        groups.set(agent.source, list);
      }
      this.groupedSources = groups;

      // Build flat display order matching visual render order
      this.displayOrder = AgentSelectionPanel.SOURCE_ORDER.flatMap(
        (source) => groups.get(source) ?? [],
      );

      // Auto-select first agent if current selection is stale or missing
      const stillValid = this.displayOrder.some(
        (a) => agentKey(a) === this.selectedKey,
      );
      if (!stillValid) {
        this.selectedKey =
          this.displayOrder.length > 0 ? agentKey(this.displayOrder[0]) : null;
      }
    }
  }

  private get selectedAgent(): AgentSelectionItem | undefined {
    return this.agents.find((a) => agentKey(a) === this.selectedKey);
  }

  private selectAgent(agent: AgentSelectionItem): void {
    this.selectedKey = agentKey(agent);
  }

  private handleListKeydown(event: KeyboardEvent): void {
    const items = this.displayOrder;
    if (items.length === 0) return;

    const currentIndex = items.findIndex(
      (a) => agentKey(a) === this.selectedKey,
    );

    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') {
      nextIndex = Math.min(currentIndex + 1, items.length - 1);
    } else if (event.key === 'ArrowUp') {
      nextIndex = Math.max(currentIndex - 1, 0);
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    if (nextIndex !== currentIndex) {
      this.selectAgent(items[nextIndex]);
      // Focus the newly selected item
      requestAnimationFrame(() => {
        const el = this.shadowRoot?.querySelector(
          '.agent-list-item.selected',
        ) as HTMLElement | null;
        el?.focus();
      });
    }
  }

  private handleOpenYaml(
    agent: AgentSelectionItem,
    variant: 'base' | 'multiple',
  ): void {
    this.dispatchEvent(
      AgentSelectionEvents.openYaml({
        agentName: agent.name,
        agentSource: agent.source,
        variant,
      }),
    );
  }

  private handleToggleEnabled(agent: AgentSelectionItem): void {
    this.dispatchEvent(
      AgentSelectionEvents.setEnabled({
        agentName: agent.name,
        agentSource: agent.source,
        category: this.category,
        enabled: !agent.enabled,
      }),
    );
  }

  private renderListItem(agent: AgentSelectionItem): TemplateResult {
    const key = agentKey(agent);
    const isSelected = this.selectedKey === key;

    return html`
      <div
        class="agent-list-item ${isSelected ? 'selected' : ''}"
        role="option"
        aria-selected=${isSelected}
        tabindex=${isSelected ? '0' : '-1'}
        @click=${() => this.selectAgent(agent)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.selectAgent(agent);
          }
        }}
        title=${agent.description ?? agent.name}
      >
        <input
          type="checkbox"
          class="agent-list-item-checkbox"
          .checked=${agent.enabled}
          @click=${(e: Event) => {
            e.stopPropagation();
            this.handleToggleEnabled(agent);
          }}
          title=${agent.enabled ? 'Hide from dropdowns' : 'Show in dropdowns'}
        />
        <span class="agent-list-item-name">${agent.name}</span>
        <span class="agent-list-item-badges">
          ${agent.hasMultiple
            ? html`<span title="Multiple outputs">⧉</span>`
            : nothing}
          ${agent.source === AGENT_SOURCE.REMOTE
            ? html`<span title="Remote agent">☁</span>`
            : nothing}
          ${agent.source === AGENT_SOURCE.CUSTOM
            ? html`<span title="Custom agent">★</span>`
            : nothing}
        </span>
      </div>
    `;
  }

  private renderList(): TemplateResult {
    const groups = this.groupedSources;
    const orderedSources = AgentSelectionPanel.SOURCE_ORDER.filter((s) =>
      groups.has(s),
    );

    // If only one source, don't show section headers
    const showHeaders = orderedSources.length > 1;

    return html`
      <div
        class="agent-list-pane"
        role="listbox"
        aria-label="Agent list"
        @keydown=${(e: KeyboardEvent) => this.handleListKeydown(e)}
      >
        ${orderedSources.map((source) => {
          const agents = groups.get(source)!;
          return html`
            ${showHeaders
              ? html`<div class="agent-list-section-header">
                  ${SOURCE_DISPLAY_NAMES[source] ?? source}
                </div>`
              : nothing}
            ${agents.map((a) => this.renderListItem(a))}
          `;
        })}
      </div>
    `;
  }

  private renderDetail(): TemplateResult {
    const agent = this.selectedAgent;

    if (!agent) {
      return html`
        <div class="agent-detail-pane">
          <div class="agent-detail-empty">Select an agent to view details</div>
        </div>
      `;
    }

    const sourceName = SOURCE_DISPLAY_NAMES[agent.source] ?? agent.source;

    return html`
      <div class="agent-detail-pane">
        <div class="agent-detail-header">
          <span class="agent-detail-name">${agent.name}</span>
          ${agent.source === AGENT_SOURCE.CUSTOM
            ? html`<span title="Custom agent">★</span>`
            : nothing}
          ${agent.source === AGENT_SOURCE.REMOTE
            ? html`<span title="Remote agent">☁</span>`
            : nothing}
        </div>

        ${agent.description
          ? html`<div class="agent-detail-description">
              ${agent.description}
            </div>`
          : nothing}

        <div class="agent-detail-meta">
          <span class="agent-detail-meta-label">Source</span>
          <span class="agent-detail-meta-value">${sourceName}</span>

          <span class="agent-detail-meta-label">Visible</span>
          <span class="agent-detail-meta-value">
            ${agent.enabled ? 'Yes' : 'No'}
          </span>

          <span class="agent-detail-meta-label">Multi-output</span>
          <span class="agent-detail-meta-value">
            ${agent.hasMultiple ? 'Yes ⧉' : 'No'}
          </span>

          ${agent.tools && agent.tools.length > 0
            ? html`
                <span class="agent-detail-meta-label">Tools</span>
                <div class="agent-detail-meta-value">
                  <div class="agent-detail-tools">
                    ${agent.tools.map(
                      (t) => html`<span class="agent-tool-badge">${t}</span>`,
                    )}
                  </div>
                </div>
              `
            : nothing}
        </div>

        <div class="agent-detail-actions">
          ${agent.hasPath
            ? html`
                <button
                  class="agent-action-btn"
                  @click=${() => this.handleOpenYaml(agent, 'base')}
                  title="Open agent YAML definition"
                >
                  <span class="codicon codicon-file-code"></span>
                  Open YAML
                </button>
              `
            : nothing}
          ${agent.hasMultiple
            ? html`
                <button
                  class="agent-action-btn"
                  @click=${() => this.handleOpenYaml(agent, 'multiple')}
                  title="Open _multiple variant YAML definition"
                >
                  <span class="codicon codicon-files"></span>
                  Open Multiple YAML
                </button>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    if (this.agents.length === 0) {
      return html` <p class="agent-empty-message">No agents available.</p> `;
    }

    const enabledCount = this.agents.filter((a) => a.enabled).length;

    return html`
      <div class="agent-split-panel">
        ${this.renderList()} ${this.renderDetail()}
      </div>
      <div class="agent-count">
        ${enabledCount}/${this.agents.length}
        agent${this.agents.length !== 1 ? 's' : ''} visible
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agent-selection-panel': AgentSelectionPanel;
  }
}
