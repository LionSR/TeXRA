/** Master-detail panel of agents for a single category (workflow or tool-use). */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import {
  LitElement,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { waIcon, type TeXRAIconName } from '@shared/wa/webAwesomeIcons';

// Local imports - shared schemas and events
import {
  AGENT_SOURCE,
  agentKey as agentKeyFromSourceName,
  type AgentCategory,
  type AgentSourceType,
} from '@shared/schemas/agent';
import type { AgentSelectionItem } from '@shared/schemas/settingsViewMessages';
import { isKnownUnsupported } from '@shared/utils/dispatcher';
import { pluralize } from '@utils/text/stringUtils';
import { agentSelectionPanelStyles } from './AgentSelectionPanel.styles';

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

/** Icon + label for the non-built-in source badge shown in both the list and detail panes. */
function sourceBadgeMeta(
  source: AgentSourceType,
): { icon: TeXRAIconName; label: string } | undefined {
  if (source === AGENT_SOURCE.CUSTOM) return { icon: 'star', label: 'Custom' };
  if (source === AGENT_SOURCE.REMOTE) return { icon: 'cloud', label: 'Remote' };
  return undefined;
}

@customElement('agent-selection-panel')
export class AgentSelectionPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    agentSelectionPanelStyles,
  ];

  @property({ attribute: false }) agents: AgentSelectionItem[] = [];
  @property({ attribute: false }) category: AgentCategory = 'workflow';
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
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML, {
      agentName: agent.name,
      agentSource: agent.source,
    });
  }

  private handleCustomizeAgent(agent: AgentSelectionItem): void {
    postMessage(SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT, {
      agentName: agent.name,
      agentSource: agent.source,
    });
  }

  private handleDeleteCustomAgent(agent: AgentSelectionItem): void {
    const key = agentKey(agent);
    if (this.pendingDeleteKey === key) {
      // Confirmed — request the delete
      this.pendingDeleteKey = null;
      postMessage(SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT, {
        agentName: agent.name,
      });
    } else {
      // First click — show confirmation
      this.pendingDeleteKey = key;
    }
  }

  private cancelDelete(): void {
    this.pendingDeleteKey = null;
  }

  private handleViewRemotePrompt(agent: AgentSelectionItem): void {
    postMessage(SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT, {
      agentName: agent.name,
    });
  }

  private handleRevealAgentFile(agent: AgentSelectionItem): void {
    postMessage(SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE, {
      agentName: agent.name,
      agentSource: agent.source,
    });
  }

  private handleToggleEnabled(agent: AgentSelectionItem): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED, {
      agentName: agent.name,
      agentSource: agent.source,
      category: this.category,
      enabled: !agent.enabled,
    });
  }

  private handleSetAllEnabled(source: AgentSourceType, enabled: boolean): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED, {
      category: this.category,
      source,
      enabled,
    });
  }

  private renderListItem(agent: AgentSelectionItem): TemplateResult {
    const key = agentKey(agent);
    const isSelected = this.selectedKey === key;
    const badge = sourceBadgeMeta(agent.source);

    let sourceTone: 'builtin' | 'custom' | 'remote';
    if (agent.source === AGENT_SOURCE.CUSTOM) {
      sourceTone = 'custom';
    } else if (agent.source === AGENT_SOURCE.REMOTE) {
      sourceTone = 'remote';
    } else {
      sourceTone = 'builtin';
    }

    return html`
      <div
        class=${classMap({ 'agent-list-item': true, selected: isSelected })}
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
        <wa-switch
          class="agent-list-item-toggle"
          ?checked=${agent.enabled}
          @click=${(e: Event) => {
            e.stopPropagation();
            this.handleToggleEnabled(agent);
          }}
          title=${
            agent.enabled
              ? 'Hide from agent selector'
              : 'Show in agent selector'
          }
        ></wa-switch>
        <span class="agent-list-item-name">${agent.name}</span>
        <span class="agent-list-item-badges">
          ${
            badge
              ? html`<span title="${badge.label} agent"
                  >${waIcon(badge.icon, { label: `${badge.label} agent` })}</span
                >`
              : nothing
          }
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
          const sourceName = SOURCE_DISPLAY_NAMES[source] ?? source;
          return html`
            <div class="agent-list-section-header">
              <span>${sourceName}</span>
              <span class="agent-list-section-actions">
                ${
                  enabledInGroup < agents.length
                    ? html`<wa-button
                        class="agent-count-link"
                        appearance="plain"
                        size="small"
                        @click=${() => this.handleSetAllEnabled(source, true)}
                        title="Show all ${sourceName} agents"
                      >
                        All
                      </wa-button>`
                    : nothing
                }
                ${
                  enabledInGroup > 0
                    ? html`<wa-button
                        class="agent-count-link"
                        appearance="plain"
                        size="small"
                        @click=${() => this.handleSetAllEnabled(source, false)}
                        title="Hide all ${sourceName} agents"
                      >
                        None
                      </wa-button>`
                    : nothing
                }
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
          <div class="agent-detail-empty">
            <em class="text-secondary">Select an agent to view details</em>
          </div>
        </div>
      `;
    }

    const builtIn = isBuiltIn(agent.source);
    const isCustom = agent.source === AGENT_SOURCE.CUSTOM;
    const showDeleteConfirm =
      isCustom && this.pendingDeleteKey === agentKey(agent);
    const badge = sourceBadgeMeta(agent.source);

    return html`
      <div class="agent-detail-pane">
        <div class="agent-detail-header">
          <span class="agent-detail-name">${agent.name}</span>
          ${
            builtIn
              ? html`<wa-tag variant="neutral" size="small">Built-in</wa-tag>`
              : nothing
          }
          ${
            badge
              ? html`<wa-tag
                  variant="neutral"
                  size="small"
                  title="${badge.label} agent"
                  >${waIcon(badge.icon)} ${badge.label}</wa-tag
                >`
              : nothing
          }
        </div>

        ${
          agent.description
            ? html`<div class="agent-detail-description">
                ${agent.description}
              </div>`
            : nothing
        }
        ${
          agent.filePath
            ? html`<div class="agent-detail-path" title=${agent.filePath}>
                ${agent.filePath.split(/[/\\]/).pop() ?? agent.filePath}
              </div>`
            : nothing
        }

        <div class="agent-detail-meta">
          <span class="agent-detail-meta-label">Available</span>
          <span class="agent-detail-meta-value">
            ${agent.enabled ? 'Yes' : 'No'}
          </span>

          ${
            agent.tools && agent.tools.length > 0
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
              : nothing
          }
        </div>

        <div class="agent-detail-actions">
          ${
            agent.hasPath
              ? html`
                  ${renderLabeledActionButton({
                    icon: 'file-lines',
                    text: 'Open YAML',
                    label: 'Open agent YAML definition',
                    className: 'agent-action-btn',
                    onClick: () => this.handleOpenYaml(agent),
                  })}
                `
              : nothing
          }
          ${
            agent.source === AGENT_SOURCE.REMOTE &&
            this.userTier === 'Ultra' &&
            !agent.hasPath &&
            !isKnownUnsupported(
              this.unsupportedCommands,
              SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT,
            )
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
              : nothing
          }
          ${
            agent.hasPath
              ? html`
                  ${renderLabeledActionButton({
                    icon: 'folder-open',
                    text: 'Reveal in File Explorer',
                    title: 'Show this file in your system file explorer',
                    className: 'agent-action-btn',
                    onClick: () => this.handleRevealAgentFile(agent),
                  })}
                `
              : nothing
          }
          ${
            builtIn &&
            !isKnownUnsupported(
              this.unsupportedCommands,
              SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT,
            )
              ? html`
                  ${renderLabeledActionButton({
                    icon: 'pencil',
                    text: 'Customize',
                    label: 'Customize agent',
                    title:
                      'Create an editable copy in your custom agents folder',
                    className: 'agent-action-btn',
                    appearance: 'filled',
                    variant: 'brand',
                    onClick: () => this.handleCustomizeAgent(agent),
                  })}
                `
              : nothing
          }
          ${
            isCustom &&
            !isKnownUnsupported(
              this.unsupportedCommands,
              SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT,
            )
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
              : nothing
          }
        </div>

        ${
          showDeleteConfirm
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
            : nothing
        }
      </div>
    `;
  }

  override render(): TemplateResult {
    if (this.agents.length === 0) {
      return html` <em class="text-secondary">No agents available.</em> `;
    }

    const enabledCount = this.agents.filter((a) => a.enabled).length;

    return html`
      <div class="agent-split-panel">
        ${this.renderList()} ${this.renderDetail()}
      </div>
      <div class="agent-count">
        ${enabledCount}/${this.agents.length}
        ${pluralize(this.agents.length, 'agent')} in dropdown
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agent-selection-panel': AgentSelectionPanel;
  }
}
