/**
 * AgentSelectionPanel component - split panel with agent list and detail pane.
 * Shows agents for a single category (workflow or tool-use) with a
 * master-detail layout: list on the left, details on the right.
 */

// Third-party imports
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
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
import { commonViewStyles, designTokens } from '@shared/styles';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

// Local imports - shared schemas and events
import {
  AGENT_SOURCE,
  agentKey as agentKeyFromSourceName,
  type AgentCategory,
  type AgentSourceType,
} from '@shared/schemas/agent';
import type { AgentSelectionItem } from '@shared/schemas/settingsViewMessages';
import { AgentSelectionEvents } from './events';

/** Shorthand: derive the canonical key from an AgentSelectionItem. */
function agentKey(agent: AgentSelectionItem): string {
  return agentKeyFromSourceName(agent.source, agent.name);
}

/** Source display names for agent origins */
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  [AGENT_SOURCE.BUILT_IN_WORKFLOW]: 'Built-in',
  [AGENT_SOURCE.BUILT_IN_TOOL_USE]: 'Built-in',
  [AGENT_SOURCE.CUSTOM]: 'Custom',
  [AGENT_SOURCE.REMOTE]: 'Remote',
};

function isBuiltIn(source: string): boolean {
  return (
    source === AGENT_SOURCE.BUILT_IN_WORKFLOW ||
    source === AGENT_SOURCE.BUILT_IN_TOOL_USE
  );
}

@customElement('agent-selection-panel')
export class AgentSelectionPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
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
        background: var(--wa-color-surface-default);
      }

      /* --- Left: Agent list --- */
      .agent-list-pane {
        width: 30%;
        min-width: 200px;
        max-width: 300px;
        border-right: var(--border-thin) solid var(--color-border);
        overflow-y: auto;
        overscroll-behavior: contain;
        flex-shrink: 0;
      }

      .agent-list-section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        background: color-mix(
          in srgb,
          var(--wa-color-surface-default) 92%,
          var(--wa-color-text-normal) 4%
        );
        border-bottom: var(--border-thin) solid var(--color-border);
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .agent-list-section-actions {
        display: flex;
        gap: var(--wa-space-2xs);
        text-transform: none;
        letter-spacing: normal;
        font-weight: normal;
      }

      .agent-list-item {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        cursor: pointer;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
        border-left: var(--border-medium) solid transparent;
        transition:
          background-color 140ms ease,
          border-left-color 140ms ease,
          box-shadow 140ms ease;
        outline: none;
      }

      /*
       * Source-tinted left rail — uses existing WA semantic colours so each
       * group gets a quiet identity cue without introducing a new palette.
       * Built-in = brand, custom = success, remote = neutral. The hairline
       * shows on hover/selected so the resting state stays calm.
       */
      .agent-list-item[data-source='custom']:hover,
      .agent-list-item[data-source='custom'].selected {
        border-left-color: var(--wa-color-success-fill-loud);
      }

      .agent-list-item[data-source='remote']:hover,
      .agent-list-item[data-source='remote'].selected {
        border-left-color: var(--wa-color-text-quiet);
      }

      .agent-list-item:hover {
        background: var(--wa-color-neutral-fill-quiet);
      }

      .agent-list-item:focus-visible {
        outline: var(--border-thin) solid var(--wa-color-focus);
        outline-offset: -1px;
      }

      .agent-list-item.selected {
        background: var(--wa-color-brand-fill-quiet);
        color: var(--wa-color-list-active-fg, var(--wa-color-text-normal));
        border-left-color: var(--wa-color-brand-fill-loud);
        box-shadow: inset 0 0 0 1px
          color-mix(in srgb, var(--wa-color-brand-fill-loud) 12%, transparent);
      }

      .agent-list-item.selected .agent-list-item-name,
      .agent-list-item.selected .agent-list-item-badges {
        color: inherit;
      }

      .agent-list-item.selected .agent-list-item-badges {
        opacity: var(--opacity-full);
      }

      .agent-list-item-checkbox {
        flex-shrink: 0;
      }

      .agent-list-item-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--wa-font-family-mono);
      }

      .agent-list-item-badges {
        display: flex;
        gap: var(--wa-space-3xs);
        font-size: var(--font-size-xs);
        opacity: var(--opacity-normal);
        flex-shrink: 0;
      }

      /* --- Right: Detail pane --- */
      .agent-detail-pane {
        flex: 1;
        overflow-y: auto;
        padding: var(--wa-space-s);
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
        gap: var(--wa-space-xs);
        margin-bottom: var(--wa-space-s);
      }

      .agent-detail-name {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        font-family: var(--wa-font-family-mono);
        color: var(--wa-color-text-normal);
      }

      .agent-detail-description {
        color: var(--wa-color-text-normal);
        line-height: var(--line-height-relaxed);
        margin-bottom: var(--wa-space-s);
      }

      .agent-detail-meta {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--wa-space-2xs) var(--wa-space-s);
        margin-bottom: var(--wa-space-s);
        font-size: var(--font-size-sm);
      }

      .agent-detail-meta-label {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        white-space: nowrap;
      }

      .agent-detail-meta-value {
        color: var(--wa-color-text-normal);
      }

      .agent-detail-tools {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
      }

      wa-tag.agent-tool-badge {
        font-family: var(--wa-font-family-mono);
      }

      .agent-detail-actions {
        display: flex;
        gap: var(--wa-space-xs);
        flex-wrap: wrap;
      }

      .agent-action-btn {
        flex-shrink: 0;
      }

      .agent-count {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        border-top: var(--border-thin) solid var(--color-border);
        background: var(--wa-color-surface-default);
      }

      wa-button.agent-count-link::part(base) {
        font-size: var(--font-size-xs);
        color: var(--wa-color-text-link);
        min-height: 0;
        padding: 0;
        border: none;
        background: transparent;
      }

      wa-button.agent-count-link::part(base):hover {
        text-decoration: underline;
      }

      .agent-empty-message {
        color: var(--color-text-secondary);
        font-style: italic;
      }

      .agent-detail-path {
        font-size: var(--font-size-xs);
        font-family: var(--wa-font-family-mono, monospace), monospace;
        color: var(--color-text-secondary);
        margin-bottom: var(--wa-space-s);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .agent-action-btn--danger::part(base) {
        color: var(--wa-color-danger-on-quiet);
        border-color: var(--wa-color-danger-on-quiet);
      }

      .agent-action-btn--danger:hover::part(base) {
        background: var(--wa-color-danger-fill-quiet);
        border-color: var(--wa-color-danger-on-quiet);
      }

      .agent-delete-confirm {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        background: var(--wa-color-danger-fill-quiet);
        border: var(--border-thin) solid var(--wa-color-danger-on-quiet);
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
      }

      .agent-delete-confirm-text {
        flex: 1;
      }

      .agent-delete-confirm-actions {
        display: flex;
        gap: var(--wa-space-2xs);
        flex-shrink: 0;
      }
    `,
  ];

  @property({ attribute: false }) agents: AgentSelectionItem[] = [];
  @property({ attribute: false }) category: AgentCategory = 'workflow';
  @property({ attribute: false }) userTier = 'free';
  @property({ type: Boolean, attribute: 'desktop-host' }) desktopHost = false;

  @state() private selectedKey: string | null = null;

  @state() private groupedSources: Map<AgentSourceType, AgentSelectionItem[]> =
    new Map();

  /** Key of agent pending delete confirmation, or null */
  @state() private pendingDeleteKey: string | null = null;

  /** Flat list in visual display order, for keyboard navigation */
  private displayOrder: AgentSelectionItem[] = [];

  private static readonly SOURCE_ORDER = [
    AGENT_SOURCE.CUSTOM,
    AGENT_SOURCE.REMOTE,
    AGENT_SOURCE.BUILT_IN_WORKFLOW,
    AGENT_SOURCE.BUILT_IN_TOOL_USE,
  ];

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('agents')) {
      const groups = new Map<AgentSourceType, AgentSelectionItem[]>();
      for (const agent of this.agents) {
        const list = groups.get(agent.source) ?? [];
        list.push(agent);
        groups.set(agent.source, list);
      }
      this.groupedSources = groups;
      this.displayOrder = AgentSelectionPanel.SOURCE_ORDER.flatMap(
        (source) => groups.get(source) ?? [],
      );

      const stillValid = this.displayOrder.some(
        (a) => agentKey(a) === this.selectedKey,
      );
      if (!stillValid) {
        this.selectedKey =
          this.displayOrder.length > 0 ? agentKey(this.displayOrder[0]) : null;
      }
      // Clear stale delete confirmation when agent list changes
      this.pendingDeleteKey = null;
    }
  }

  private get selectedAgent(): AgentSelectionItem | undefined {
    return this.agents.find((a) => agentKey(a) === this.selectedKey);
  }

  private selectAgent(agent: AgentSelectionItem): void {
    this.selectedKey = agentKey(agent);
    this.pendingDeleteKey = null;
  }

  private handleListKeydown(event: KeyboardEvent): void {
    const items = this.displayOrder;
    if (items.length === 0) return;

    const currentIndex = items.findIndex(
      (a) => agentKey(a) === this.selectedKey,
    );

    let nextIndex: number;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = Math.min(currentIndex + 1, items.length - 1);
        break;
      case 'ArrowUp':
        nextIndex = Math.max(currentIndex - 1, 0);
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = items.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    if (nextIndex !== currentIndex) {
      this.selectAgent(items[nextIndex]);
      requestAnimationFrame(() => {
        const el = this.shadowRoot?.querySelector(
          '.agent-list-item.selected',
        ) as HTMLElement | null;
        el?.focus();
      });
    }
  }

  private handleOpenYaml(agent: AgentSelectionItem): void {
    this.dispatchEvent(
      AgentSelectionEvents.openYaml({
        agentName: agent.name,
        agentSource: agent.source,
      }),
    );
  }

  private handleCustomizeAgent(agent: AgentSelectionItem): void {
    this.dispatchEvent(
      AgentSelectionEvents.customizeAgent({
        agentName: agent.name,
        agentSource: agent.source,
      }),
    );
  }

  private handleDeleteCustomAgent(agent: AgentSelectionItem): void {
    const key = agentKey(agent);
    if (this.pendingDeleteKey === key) {
      // Confirmed — dispatch the delete event
      this.pendingDeleteKey = null;
      this.dispatchEvent(
        AgentSelectionEvents.deleteCustomAgent({ agentName: agent.name }),
      );
    } else {
      // First click — show confirmation
      this.pendingDeleteKey = key;
    }
  }

  private cancelDelete(): void {
    this.pendingDeleteKey = null;
  }

  private handleViewRemotePrompt(agent: AgentSelectionItem): void {
    this.dispatchEvent(
      AgentSelectionEvents.viewRemotePrompt({ agentName: agent.name }),
    );
  }

  private handleRevealAgentFile(agent: AgentSelectionItem): void {
    this.dispatchEvent(
      AgentSelectionEvents.revealAgentFile({
        agentName: agent.name,
        agentSource: agent.source,
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

  private handleSetAllEnabled(source: AgentSourceType, enabled: boolean): void {
    this.dispatchEvent(
      AgentSelectionEvents.setAllEnabled({
        category: this.category,
        source,
        enabled,
      }),
    );
  }

  private renderListItem(agent: AgentSelectionItem): TemplateResult {
    const key = agentKey(agent);
    const isSelected = this.selectedKey === key;

    const sourceTone = isBuiltIn(agent.source)
      ? 'builtin'
      : agent.source === AGENT_SOURCE.CUSTOM
        ? 'custom'
        : agent.source === AGENT_SOURCE.REMOTE
          ? 'remote'
          : 'builtin';

    return html`
      <div
        class="agent-list-item ${isSelected ? 'selected' : ''}"
        data-source=${sourceTone}
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
        <wa-checkbox
          class="agent-list-item-checkbox"
          ?checked=${agent.enabled}
          @click=${(e: Event) => {
            e.stopPropagation();
            this.handleToggleEnabled(agent);
          }}
          title=${agent.enabled
            ? 'Hide from agent selector'
            : 'Show in agent selector'}
        ></wa-checkbox>
        <span class="agent-list-item-name">${agent.name}</span>
        <span class="agent-list-item-badges">
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

    return html`
      <div
        class="agent-list-pane"
        role="listbox"
        aria-label="Agent list"
        @keydown=${(e: KeyboardEvent) => this.handleListKeydown(e)}
      >
        ${orderedSources.map((source) => {
          const agents = groups.get(source)!;
          const enabledInGroup = agents.filter((a) => a.enabled).length;
          return html`
            <div class="agent-list-section-header">
              <span>${SOURCE_DISPLAY_NAMES[source] ?? source}</span>
              <span class="agent-list-section-actions">
                ${enabledInGroup < agents.length
                  ? html`<wa-button
                      class="agent-count-link"
                      appearance="plain"
                      size="small"
                      @click=${() => this.handleSetAllEnabled(source, true)}
                      title="Show all ${SOURCE_DISPLAY_NAMES[source] ??
                      source} agents"
                    >
                      All
                    </wa-button>`
                  : nothing}
                ${enabledInGroup > 0
                  ? html`<wa-button
                      class="agent-count-link"
                      appearance="plain"
                      size="small"
                      @click=${() => this.handleSetAllEnabled(source, false)}
                      title="Hide all ${SOURCE_DISPLAY_NAMES[source] ??
                      source} agents"
                    >
                      None
                    </wa-button>`
                  : nothing}
              </span>
            </div>
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

    const builtIn = isBuiltIn(agent.source);
    const isCustom = agent.source === AGENT_SOURCE.CUSTOM;
    const showDeleteConfirm =
      isCustom && this.pendingDeleteKey === agentKey(agent);

    return html`
      <div class="agent-detail-pane">
        <div class="agent-detail-header">
          <span class="agent-detail-name">${agent.name}</span>
          ${builtIn
            ? html`<wa-tag variant="neutral" size="small">Built-in</wa-tag>`
            : nothing}
          ${isCustom
            ? html`<wa-tag variant="neutral" size="small" title="Custom agent"
                >★ Custom</wa-tag
              >`
            : nothing}
          ${agent.source === AGENT_SOURCE.REMOTE
            ? html`<wa-tag variant="neutral" size="small" title="Remote agent"
                >☁ Remote</wa-tag
              >`
            : nothing}
        </div>

        ${agent.description
          ? html`<div class="agent-detail-description">
              ${agent.description}
            </div>`
          : nothing}
        ${agent.filePath
          ? html`<div class="agent-detail-path" title=${agent.filePath}>
              ${agent.filePath.split(/[/\\]/).pop() ?? agent.filePath}
            </div>`
          : nothing}

        <div class="agent-detail-meta">
          <span class="agent-detail-meta-label">Available</span>
          <span class="agent-detail-meta-value">
            ${agent.enabled ? 'Yes' : 'No'}
          </span>

          ${agent.tools && agent.tools.length > 0
            ? html`
                <span class="agent-detail-meta-label">Tools</span>
                <div class="agent-detail-meta-value">
                  <div class="agent-detail-tools">
                    ${agent.tools.map(
                      (t) =>
                        html`<wa-tag
                          class="agent-tool-badge"
                          variant="neutral"
                          size="small"
                          >${t}</wa-tag
                        >`,
                    )}
                  </div>
                </div>
              `
            : nothing}
        </div>

        <div class="agent-detail-actions">
          ${agent.hasPath
            ? html`
                ${renderLabeledActionButton({
                  icon: 'file-lines',
                  text: 'Open YAML',
                  label: 'Open agent YAML definition',
                  className: 'agent-action-btn',
                  onClick: () => this.handleOpenYaml(agent),
                })}
              `
            : nothing}
          ${agent.source === AGENT_SOURCE.REMOTE &&
          this.userTier === 'Ultra' &&
          !agent.hasPath &&
          !this.desktopHost
            ? html`
                ${renderLabeledActionButton({
                  icon: 'file-lines',
                  text: 'View Prompt',
                  label: "View the remote agent's prompt definition",
                  title:
                    "View the remote agent's prompt definition (read-only)",
                  className: 'agent-action-btn',
                  onClick: () => this.handleViewRemotePrompt(agent),
                })}
              `
            : nothing}
          ${agent.hasPath
            ? html`
                ${renderLabeledActionButton({
                  icon: 'folder-open',
                  text: 'Reveal in File Explorer',
                  title: 'Show this file in your system file explorer',
                  className: 'agent-action-btn',
                  onClick: () => this.handleRevealAgentFile(agent),
                })}
              `
            : nothing}
          ${builtIn && !this.desktopHost
            ? html`
                ${renderLabeledActionButton({
                  icon: 'pencil',
                  text: 'Customize',
                  label: 'Customize agent',
                  title: 'Create an editable copy in your custom agents folder',
                  className: 'agent-action-btn',
                  appearance: 'filled',
                  variant: 'brand',
                  onClick: () => this.handleCustomizeAgent(agent),
                })}
              `
            : nothing}
          ${isCustom && !this.desktopHost
            ? html`
                ${renderLabeledActionButton({
                  icon: 'trash',
                  text: 'Delete',
                  label: 'Delete custom agent',
                  title: 'Delete this custom agent',
                  className: 'agent-action-btn agent-action-btn--danger',
                  onClick: () => this.handleDeleteCustomAgent(agent),
                })}
              `
            : nothing}
        </div>

        ${showDeleteConfirm
          ? html`
              <div class="agent-delete-confirm">
                <span class="agent-delete-confirm-text">
                  Delete custom agent "${agent.name}"? This cannot be undone.
                </span>
                <div class="agent-delete-confirm-actions">
                  ${renderLabeledActionButton({
                    icon: 'trash',
                    text: 'Delete',
                    label: 'Confirm delete custom agent',
                    className: 'agent-action-btn agent-action-btn--danger',
                    onClick: () => this.handleDeleteCustomAgent(agent),
                  })}
                  ${renderLabeledActionButton({
                    icon: 'xmark',
                    text: 'Cancel',
                    label: 'Cancel delete custom agent',
                    className: 'agent-action-btn',
                    onClick: () => this.cancelDelete(),
                  })}
                </div>
              </div>
            `
          : nothing}
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
        agent${this.agents.length !== 1 ? 's' : ''} in dropdown
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agent-selection-panel': AgentSelectionPanel;
  }
}
