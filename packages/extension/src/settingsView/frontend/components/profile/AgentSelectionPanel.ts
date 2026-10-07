/** Master-detail panel of the agent library, grouped by source. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { AgentSource } from '@shared/schemas';
import type { AgentSelectionItem } from '@shared/settingsView/settingsViewMessages';
import {
  AGENT_SOURCE,
  agentKey as agentKeyFromSourceName,
  isPackagedAgentSource,
} from '@shared/schemas';
import type { TeXRAIconName } from '@shared/iconNames';
import {
  commonViewStyles,
  designTokens,
  settingsBannerStyles,
} from '@ui/styles';
import {
  renderIconActionButton,
  renderLabeledActionButton,
  type LabeledActionButtonOptions,
} from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { AGENT_DECORATORS } from '@ui/wa/icons';
import { getBasename } from '@utils/core';

// Local imports - shared schemas and events
import { catalogDetailStyles } from '../shared/catalogDetailStyles';
import '../shared/SettingsCatalog';
import { renderNewerBuiltInNotice } from './newerBuiltInNotice';
import type { SettingsCatalogItem } from '../shared/SettingsCatalog';

/** Shorthand: derive the canonical key from an AgentSelectionItem. */
function agentKey(agent: AgentSelectionItem): string {
  return agentKeyFromSourceName(agent.source, agent.name);
}

/**
 * Per-source presentation: section heading name and the badge (icon + label)
 * shown for non-built-in origins in both list and detail panes. The badge is
 * read from the shared `AGENT_DECORATORS.properties` table so this pane and
 * the launcher dropdown cannot drift on glyph or label; the built-in
 * source has no row there and carries no badge.
 */
function sourceMeta(source: AgentSource): {
  displayName: string;
  badge?: { icon: TeXRAIconName; label: string };
} {
  const { properties } = AGENT_DECORATORS;
  if (!(source in properties)) {
    return { displayName: 'Built-in' };
  }
  const badge = properties[source as keyof typeof properties];
  return { displayName: badge.label, badge };
}

@customElement('agent-selection-panel')
export class AgentSelectionPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    settingsBannerStyles,
    catalogDetailStyles,
  ];

  @property({ attribute: false }) agents: AgentSelectionItem[] = [];

  @state() private selectedKey: string | null = null;

  private get selectedAgent(): AgentSelectionItem | undefined {
    return (
      this.agents.find((agent) => agentKey(agent) === this.selectedKey) ??
      this.agents[0]
    );
  }

  private catalogItem(agent: AgentSelectionItem): SettingsCatalogItem {
    const key = agentKey(agent);
    return {
      key,
      name: agent.name,
      group: sourceMeta(agent.source).displayName,
      description:
        agent.description ||
        (agent.hasTask ? 'Chat and document tasks' : 'Chat agent'),
      searchText: agent.tools?.join(' '),
      badges: html`${agent.hasTask ? waIcon('file-lines', { label: 'Document task' }) : nothing}
      ${agent.newerBuiltIn ? waIcon('arrow-up', { label: 'Newer built-in version available' }) : nothing}`,
      control: renderIconActionButton({
        id: `agent-visible-${encodeURIComponent(key)}`,
        className: 'catalog-row-toggle',
        icon: agent.enabled ? 'eye' : 'eye-slash',
        label: `Show ${agent.name} in agent selector`,
        tooltip: agent.enabled
          ? 'Shown in agent selector'
          : 'Hidden from agent selector',
        pressed: agent.enabled,
        onClick: (event) => {
          event.stopPropagation();
          postMessage(SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED, {
            agentName: agent.name,
            agentSource: agent.source,
            enabled: !agent.enabled,
          });
        },
      }),
    };
  }

  /** Detail-pane actions in render order, each with the condition that shows it. */
  private renderDetailActions(agent: AgentSelectionItem): TemplateResult[] {
    const builtIn = isPackagedAgentSource(agent.source);
    const isCustom = agent.source === AGENT_SOURCE.CUSTOM;
    const actions: ReadonlyArray<{
      readonly when: boolean;
      readonly button: LabeledActionButtonOptions;
    }> = [
      {
        when: agent.hasPath,
        button: {
          icon: 'file-lines',
          // A packaged definition ships inside the app and cannot be edited
          // in place; Customize is the action that produces an editable copy.
          text: builtIn ? 'View YAML' : 'Open YAML',
          label: builtIn
            ? 'View agent YAML definition'
            : 'Open agent YAML definition',
          title: builtIn
            ? 'View the built-in definition (read-only). Use Customize to edit it.'
            : 'Open this agent YAML definition for editing',
          className: 'catalog-action-btn',
          kind: 'ghost',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML, {
              agentName: agent.name,
              agentSource: agent.source,
            }),
        },
      },
      {
        when: agent.hasPath,
        button: {
          icon: 'folder-open',
          text: 'Reveal in file explorer',
          title: 'Show this file in your system file explorer',
          className: 'catalog-action-btn',
          kind: 'ghost',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE, {
              agentName: agent.name,
              agentSource: agent.source,
            }),
        },
      },
      {
        // A plugin agent is a Claude Code subagent file, not agent YAML: it
        // has no editable copy to make.
        when: builtIn && agent.source !== AGENT_SOURCE.PLUGIN,
        button: {
          icon: 'pencil',
          text: 'Customize',
          label: 'Customize agent',
          title: 'Create an editable copy in your custom agents folder',
          className: 'catalog-action-btn',
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
        when: isCustom,
        button: {
          icon: 'trash',
          text: 'Delete',
          label: 'Delete custom agent',
          title: 'Delete this custom agent',
          className: 'catalog-action-btn',
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

  private renderDetail(agent: AgentSelectionItem): TemplateResult {
    const { displayName, badge } = sourceMeta(agent.source);

    return html`
      <section
        class="catalog-detail-pane"
        id="catalog-detail"
        aria-labelledby="catalog-detail-name"
      >
        <div class="catalog-detail-header">
          <h3 class="catalog-detail-name" id="catalog-detail-name">
            <bdi dir="auto">${agent.name}</bdi>
          </h3>
          <wa-tag variant="neutral" size="s" title="${displayName} agent"
            >${badge ? html`${waIcon(badge.icon)} ` : nothing}${displayName}</wa-tag
          >
          ${
            agent.hasTask
              ? html`<wa-tag
                  variant="neutral"
                  size="s"
                  title="Can also revise selected files as a document task"
                  >${waIcon('file-lines')} document task</wa-tag
                >`
              : nothing
          }
        </div>

        <div class="catalog-detail-actions">
          ${this.renderDetailActions(agent)}
        </div>
        ${renderNewerBuiltInNotice(agent)}
        ${
          agent.description
            ? html`<div class="catalog-detail-description" dir="auto">
                ${agent.description}
              </div>`
            : nothing
        }
        ${
          agent.filePath
            ? html`<div class="catalog-detail-path" title=${agent.filePath}>
                <bdi dir="auto">${getBasename(agent.filePath)}</bdi>
              </div>`
            : nothing
        }

        <dl class="catalog-detail-meta">
          ${
            agent.tools?.length
              ? html`
                  <dt class="catalog-detail-meta-label">Tools</dt>
                  <dd class="catalog-detail-meta-value">
                    <div class="catalog-detail-tools">
                      ${agent.tools.map(
                        (t) =>
                          html`<wa-tag
                            class="catalog-tool-badge"
                            variant="neutral"
                            size="s"
                            ><bdi dir="auto">${t}</bdi></wa-tag
                          >`,
                      )}
                    </div>
                  </dd>
                `
              : nothing
          }
        </dl>
      </section>
    `;
  }

  override render(): TemplateResult {
    const agent = this.selectedAgent;
    const sources = [
      AGENT_SOURCE.CUSTOM,
      AGENT_SOURCE.BUILT_IN,
      AGENT_SOURCE.PLUGIN,
    ];
    const items = sources.flatMap((source) =>
      this.agents
        .filter((item) => item.source === source)
        .map((item) => this.catalogItem(item)),
    );
    return html`
      <settings-catalog
        label="Agents"
        actionLabel="Visible"
        placeholder="Search name, purpose, or tool"
        .items=${items}
        .selectedKey=${this.selectedKey}
        @catalog-select=${(event: CustomEvent<string | null>) => {
          this.selectedKey = event.detail;
        }}
      >
        <div slot="actions" class="catalog-toolbar-actions">
          <wa-dropdown>
            <wa-button slot="trigger" appearance="plain" size="s"
              >Visibility</wa-button
            >
            ${sources
              .filter((source) =>
                this.agents.some((entry) => entry.source === source),
              )
              .map((source) =>
                [true, false].map(
                  (enabled) => html`
                    <wa-dropdown-item
                      @click=${() => postMessage(SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED, { source, enabled })}
                    >
                      ${waIcon(enabled ? 'eye' : 'eye-slash', { slot: 'icon' })}
                      ${enabled ? 'Show' : 'Hide'} all
                      ${sourceMeta(source).displayName.toLocaleLowerCase()}
                      agents
                    </wa-dropdown-item>
                  `,
                ),
              )}
          </wa-dropdown>
          <slot name="actions"></slot>
        </div>
        <div slot="detail">${agent ? this.renderDetail(agent) : nothing}</div>
      </settings-catalog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agent-selection-panel': AgentSelectionPanel;
  }
}
