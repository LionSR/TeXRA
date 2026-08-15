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
import type {
  AgentCategory,
  AgentSelectionItem,
  AgentSource,
} from '@shared/schemas';
import {
  AGENT_SOURCE,
  agentKey as agentKeyFromSourceName,
} from '@shared/schemas';
import { UnsupportedCommandsMixin } from '@shared/wa/unsupportedCommandsMixin';
import {
  renderLabeledActionButton,
  type LabeledActionButtonOptions,
} from '@shared/wa/actionButtons';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - shared schemas and events
import { isKnownUnsupported } from '@shared/utils/dispatcher';
import { pluralize } from '@utils/text/stringUtils';
import { agentSelectionPanelStyles } from './AgentSelectionPanel.styles';

/** Shorthand: derive the canonical key from an AgentSelectionItem. */
function agentKey(agent: AgentSelectionItem): string {
  return agentKeyFromSourceName(agent.source, agent.name);
}

/**
 * Per-source presentation: section heading name, list-row tone, and the badge
 * (icon + label) shown for non-built-in origins in both list and detail panes.
 */
const SOURCE_META: Record<
  AgentSource,
  {
    displayName: string;
    tone: 'builtin' | 'custom' | 'remote' | 'inline';
    badge?: { icon: TeXRAIconName; label: string };
  }
> = {
  [AGENT_SOURCE.BUILT_IN_WORKFLOW]: {
    displayName: 'Built-in',
    tone: 'builtin',
  },
  [AGENT_SOURCE.BUILT_IN_TOOL_USE]: {
    displayName: 'Built-in',
    tone: 'builtin',
  },
  [AGENT_SOURCE.CUSTOM]: {
    displayName: 'Custom',
    tone: 'custom',
    badge: { icon: 'star', label: 'Custom' },
  },
  [AGENT_SOURCE.REMOTE]: {
    displayName: 'Remote',
    tone: 'remote',
  },
  [AGENT_SOURCE.INLINE]: {
    displayName: 'Inline',
    tone: 'inline',
    badge: { icon: 'bolt', label: 'Inline' },
  },
};

@customElement('agent-selection-panel')
export class AgentSelectionPanel extends UnsupportedCommandsMixin(LitElement) {
  static override styles = [
    designTokens,
    commonViewStyles,
    agentSelectionPanelStyles,
  ];

  @property({ attribute: false }) agents: AgentSelectionItem[] = [];
  @property({ attribute: false }) category: AgentCategory = 'workflow';

  @state() private selectedKey: string | null = null;

  @state() private groupedSources: Map<AgentSource, AgentSelectionItem[]> =
    new Map();

  /** Flat list in visual display order, for keyboard navigation */
  private displayOrder: AgentSelectionItem[] = [];

  private static readonly SOURCE_ORDER = [
    AGENT_SOURCE.INLINE,
    AGENT_SOURCE.CUSTOM,
    AGENT_SOURCE.REMOTE,
    AGENT_SOURCE.BUILT_IN_WORKFLOW,
    AGENT_SOURCE.BUILT_IN_TOOL_USE,
  ];

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('agents')) {
      const groups = new Map<AgentSource, AgentSelectionItem[]>();
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
        const first = this.displayOrder[0];
        this.selectedKey = first ? agentKey(first) : null;
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

  private handleSetAllEnabled(source: AgentSource, enabled: boolean): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED, {
      category: this.category,
      source,
      enabled,
    });
  }

  private renderListItem(agent: AgentSelectionItem): TemplateResult {
    const key = agentKey(agent);
    const isSelected = this.selectedKey === key;
    const { tone, badge } = SOURCE_META[agent.source];

    return html`
      <div
        class=${classMap({
          'agent-list-item': true,
          'focus-ring-inset': true,
          selected: isSelected,
        })}
        data-source=${tone}
        role="option"
        aria-selected=${isSelected}
        tabindex=${isSelected ? '0' : '-1'}
        @click=${() => this.selectAgent(agent)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            // Ignore Enter/Space that bubbled out of the nested wa-switch —
            // it owns its own activation and must not also select the row
            // (same guard as the preset cards in MultiAgentTab).
            if ((e.target as HTMLElement | null)?.closest('wa-switch')) {
              return;
            }
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
            postMessage(SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED, {
              agentName: agent.name,
              agentSource: agent.source,
              category: this.category,
              enabled: !agent.enabled,
            });
          }}
          title="Show in agent selector"
        >
          <!-- Slotted (not a host aria-label, which names the custom element
               rather than the inner switch — see settingsSection.ts). The
               constant wording keeps the name stable across state; checked
               carries the state. -->
          <span class="visually-hidden"
            >Show ${agent.name} in agent selector</span
          >
        </wa-switch>
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
          const sourceName = SOURCE_META[source].displayName;
          return html`
            <div class="agent-list-section-header">
              <span>${sourceName}</span>
              <span class="agent-list-section-actions">
                ${
                  enabledInGroup < agents.length
                    ? html`<wa-button
                        class="agent-count-link btn-ghost is-link"
                        appearance="plain"
                        size="s"
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
                        class="agent-count-link btn-ghost is-link"
                        appearance="plain"
                        size="s"
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

  private supportsCommand(command: string): boolean {
    return !isKnownUnsupported(this.unsupportedCommands, command);
  }

  /** Detail-pane actions in render order, each with the condition that shows it. */
  private renderDetailActions(agent: AgentSelectionItem): TemplateResult[] {
    const builtIn = SOURCE_META[agent.source].tone === 'builtin';
    const isCustom = agent.source === AGENT_SOURCE.CUSTOM;
    const actions: ReadonlyArray<{
      readonly when: boolean;
      readonly button: LabeledActionButtonOptions;
    }> = [
      {
        when: agent.hasPath,
        button: {
          icon: 'file-lines',
          text: 'Open YAML',
          label: 'Open agent YAML definition',
          className: 'agent-action-btn',
          kind: 'ghost',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML, {
              agentName: agent.name,
              agentSource: agent.source,
            }),
        },
      },
      {
        when:
          agent.source === AGENT_SOURCE.REMOTE &&
          !agent.hasPath &&
          this.supportsCommand(SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT),
        button: {
          icon: 'file-lines',
          text: 'View prompt',
          label: "View the remote agent's prompt definition",
          title: "View the remote agent's prompt definition (read-only)",
          className: 'agent-action-btn',
          kind: 'ghost',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT, {
              agentName: agent.name,
            }),
        },
      },
      {
        when: agent.hasPath,
        button: {
          icon: 'folder-open',
          text: 'Reveal in file explorer',
          title: 'Show this file in your system file explorer',
          className: 'agent-action-btn',
          kind: 'ghost',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE, {
              agentName: agent.name,
              agentSource: agent.source,
            }),
        },
      },
      {
        when:
          builtIn &&
          this.supportsCommand(SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT),
        button: {
          icon: 'pencil',
          text: 'Customize',
          label: 'Customize agent',
          title: 'Create an editable copy in your custom agents folder',
          className: 'agent-action-btn',
          appearance: 'filled',
          variant: 'brand',
          kind: 'primary',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT, {
              agentName: agent.name,
              agentSource: agent.source,
            }),
        },
      },
      {
        when:
          isCustom &&
          this.supportsCommand(SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT),
        button: {
          icon: 'trash',
          text: 'Delete',
          label: 'Delete custom agent',
          title: 'Delete this custom agent',
          className: 'agent-action-btn',
          kind: 'danger',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT, {
              agentName: agent.name,
            }),
        },
      },
    ];

    return actions
      .filter((action) => action.when)
      .map((action) => renderLabeledActionButton(action.button));
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

    const { tone, badge } = SOURCE_META[agent.source];
    const builtIn = tone === 'builtin';

    return html`
      <div class="agent-detail-pane">
        <div class="agent-detail-header">
          <span class="agent-detail-name">${agent.name}</span>
          ${
            builtIn
              ? html`<wa-tag variant="neutral" size="s">Built-in</wa-tag>`
              : nothing
          }
          ${
            badge
              ? html`<wa-tag
                  variant="neutral"
                  size="s"
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
            agent.tools?.length
              ? html`
                  <span class="agent-detail-meta-label">Tools</span>
                  <div class="agent-detail-meta-value">
                    <div class="agent-detail-tools">
                      ${agent.tools.map(
                        (t) =>
                          html`<wa-tag
                            class="agent-tool-badge"
                            variant="neutral"
                            size="s"
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
          ${this.renderDetailActions(agent)}
        </div>
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
