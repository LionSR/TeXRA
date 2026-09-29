import '@awesome.me/webawesome/dist/components/switch/switch.js';

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  AGENT_SKILLS_CONFIG_KEY,
  ActiveSkillSourceScopeSchema,
  type ActiveSkillSourceScope,
  type SkillDisplayIssue,
  type SkillDisplayItem,
} from '@shared/schemas';
import { postMessage } from '@shared/hostBridge';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  PluginActionMessage,
  PluginListItem,
} from '@shared/settingsView/pluginMessages';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { commonViewStyles, designTokens } from '@ui/styles';
import { renderEmptyState } from '@ui/wa/emptyState';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';
import { groupBy } from '@utils/core';
import { pluralize } from '@utils/text/stringUtils';

import {
  postStateSetting,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';

import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

const SOURCE_LABELS: Record<ActiveSkillSourceScope, string> = {
  bundled: 'Bundled',
  project: 'Project',
  user: 'User',
  custom: 'Custom',
  interop: 'Imported',
};

@customElement('skills-tab')
export class SkillsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }
      code {
        overflow-wrap: anywhere;
      }
      .skill-issues {
        color: var(--wa-color-danger-text);
      }
    `,
  ];

  @property({ type: Boolean }) masterEnabled = false;
  @property({ attribute: false }) disabledSkills: string[] = [];
  @property({ attribute: false }) disabledSources: ActiveSkillSourceScope[] =
    [];
  @property({ attribute: false }) plugins: PluginListItem[] = [];
  @property({ attribute: false }) skills: SkillDisplayItem[] = [];
  @property({ attribute: false }) issues: SkillDisplayIssue[] = [];

  private toggleValue<T>(
    values: readonly T[],
    value: T,
    enabled: boolean,
  ): T[] {
    return enabled
      ? values.filter((candidate) => candidate !== value)
      : [...new Set([...values, value])];
  }

  /** The whole-source switch, in that source's list heading. */
  private renderSourceToggle(scope: ActiveSkillSourceScope): TemplateResult {
    return html`
      <wa-switch
        id=${`skill-source-${scope}`}
        .checked=${!this.disabledSources.includes(scope)}
        ?disabled=${!this.masterEnabled}
        @change=${(event: Event) =>
          postStateSetting(
            WorkspaceStateKey.DISABLED_SKILL_SOURCES,
            this.toggleValue(
              this.disabledSources,
              scope,
              Boolean((event.target as WaSwitch).checked),
            ),
          )}
        >Use ${SOURCE_LABELS[scope].toLowerCase()} skills</wa-switch
      >
    `;
  }

  private renderSkill(item: SkillDisplayItem): TemplateResult {
    const sourceEnabled = !this.disabledSources.includes(item.scope);
    const id = `skill-${item.scope}-${item.name}`;
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <label class="settings-row-label" for=${id}>Use ${item.name}</label>
          <span class="settings-row-help">${item.description}</span>
          <span class="settings-row-help"><code>${item.path}</code></span>
        </div>
        <div class="settings-row-control">
          <wa-switch
            id=${id}
            .checked=${item.enabled}
            ?disabled=${!this.masterEnabled || !sourceEnabled}
            @change=${(event: Event) =>
              postStateSetting(
                WorkspaceStateKey.DISABLED_SKILLS,
                this.toggleValue(
                  this.disabledSkills,
                  item.name,
                  Boolean((event.target as WaSwitch).checked),
                ),
              )}
          ></wa-switch>
        </div>
      </div>
    `;
  }

  /** One installed plugin: what it holds, its switch, and its actions.
   *  Switching one on asks the host to show what it declares and trust it. */
  private renderPlugin(plugin: PluginListItem): TemplateResult {
    const act = (action: PluginActionMessage['action']) =>
      postMessage(SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION, {
        action,
        name: plugin.name,
      });
    let state = `Skills ${plugin.skillCount}, commands ${plugin.commandCount}, agents ${plugin.agentCount}, MCP servers ${plugin.mcpServers.length}.`;
    if (plugin.code.length > 0)
      state = `Ships ${plugin.code.join(', ')}, which TeXRA does not run yet.`;
    else if (plugin.enabled && !plugin.trusted)
      state =
        'Changed since you trusted it: it loads nothing until you review it.';
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <label class="settings-row-label" for=${`plugin-${plugin.name}`}
            >${plugin.name}${plugin.version ? ` ${plugin.version}` : ''}</label
          >
          <span class="settings-row-help"
            ><code>${plugin.source}</code>${
              plugin.commit
                ? html` at <code>${plugin.commit.slice(0, 12)}</code>`
                : nothing
            }</span
          >
          <span class="settings-row-help">${plugin.problem ?? state}</span>
        </div>
        <div class="settings-row-control">
          ${
            plugin.enabled && !plugin.trusted
              ? renderLabeledActionButton({
                  icon: 'shield',
                  text: 'Review',
                  kind: 'secondary',
                  appearance: 'outlined',
                  onClick: () => act('enable'),
                })
              : nothing
          }
          ${renderLabeledActionButton({
            icon: 'rotate-right',
            text: 'Update',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: () => act('update'),
          })}
          ${renderLabeledActionButton({
            icon: 'trash',
            text: 'Remove',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: () => act('remove'),
          })}
          <wa-switch
            id=${`plugin-${plugin.name}`}
            .checked=${plugin.enabled}
            ?disabled=${plugin.code.length > 0 || plugin.problem !== undefined}
            @change=${(event: Event) =>
              act((event.target as WaSwitch).checked ? 'enable' : 'disable')}
          ></wa-switch>
        </div>
      </div>
    `;
  }

  /**
   * Installed Claude Code and Codex plugins: the one install record the CLI's
   * `texra plugin` shares. Their skills and commands are listed below with
   * the user skills, as `<plugin>:<name>`.
   */
  private renderPlugins(): TemplateResult {
    return html`
      <div class="category-section">
        ${renderSettingsSectionHeading({
          icon: 'cube',
          title: `Plugins (${this.plugins.length})`,
          description:
            'Claude Code and Codex plugins: their skills, commands, agents and MCP servers.',
          actions: renderLabeledActionButton({
            icon: 'plus',
            text: 'Install plugin',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: () =>
              postMessage(SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION, {
                action: 'install',
              }),
          }),
        })}
        <div class="settings-section">
          ${repeat(
            this.plugins,
            (plugin) => plugin.name,
            (plugin) => this.renderPlugin(plugin),
          )}
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    const groups = groupBy(this.skills, (skill) => skill.scope);
    return html`
      <div>
        ${renderSettingsSectionHeading({
          icon: 'wand-magic-sparkles',
          title: 'Skills',
          description:
            'Reusable instructions agents can load when a task needs them.',
        })}
        <div class="settings-section">
          ${renderStateSettingToggleRow({
            key: AGENT_SKILLS_CONFIG_KEY,
            checked: this.masterEnabled,
          })}
        </div>
        ${this.renderPlugins()}
        ${
          this.issues.length === 0
            ? nothing
            : html`<div class="skill-issues" role="status">
                ${this.issues.length} skill load
                ${pluralize(this.issues.length, 'issue')}:
                ${this.issues.map((issue) => issue.message).join('; ')}
              </div>`
        }
        ${
          this.skills.length === 0
            ? renderEmptyState({
                icon: 'wand-magic-sparkles',
                title: 'No skills found',
                headingTag: 'h3',
                className: 'empty-state',
              })
            : ActiveSkillSourceScopeSchema.options.flatMap((scope) => {
                const items = groups.get(scope);
                return items
                  ? [
                      html`<div class="category-section">
                        ${renderSettingsSectionHeading({
                          icon: 'wand-magic-sparkles',
                          title: `${SOURCE_LABELS[scope]} (${items.length})`,
                          description: `Skills discovered from ${scope} sources.`,
                          actions: this.renderSourceToggle(scope),
                        })}
                        <div class="settings-section">
                          ${repeat(
                            items,
                            (item) => item.path,
                            (item) => this.renderSkill(item),
                          )}
                        </div>
                      </div>`,
                    ]
                  : [];
              })
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'skills-tab': SkillsTab;
  }
}
