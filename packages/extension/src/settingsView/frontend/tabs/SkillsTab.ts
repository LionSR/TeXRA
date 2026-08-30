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
import { commonViewStyles, designTokens } from '@shared/styles';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';
import { groupBy } from '@utils/core';

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
      .empty-state {
        padding-block: var(--wa-space-l);
        text-align: center;
      }
    `,
  ];

  @property({ type: Boolean }) masterEnabled = false;
  @property({ attribute: false }) disabledSkills: string[] = [];
  @property({ attribute: false }) disabledSources: ActiveSkillSourceScope[] =
    [];
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

  private renderSourceToggle(scope: ActiveSkillSourceScope): TemplateResult {
    const checked = !this.disabledSources.includes(scope);
    const id = `skill-source-${scope}`;
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <label class="settings-row-label" for=${id}
            >Use ${SOURCE_LABELS[scope].toLowerCase()} skills</label
          >
          <span class="settings-row-help">Skills from ${scope} sources.</span>
        </div>
        <div class="settings-row-control">
          <wa-switch
            id=${id}
            .checked=${checked}
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
          ></wa-switch>
        </div>
      </div>
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

  override render(): TemplateResult {
    const groups = groupBy(this.skills, (skill) => skill.scope);
    return html`
      <div class="tab-content-container">
        <div class="settings-section">
          ${renderStateSettingToggleRow({
            key: AGENT_SKILLS_CONFIG_KEY,
            checked: this.masterEnabled,
          })}
        </div>
        <div class="category-section">
          ${renderSettingsSectionHeading({
            icon: 'folder-tree',
            title: 'Sources',
            description: 'Choose which workspace skill sources are available.',
          })}
          <div class="settings-section">
            ${ActiveSkillSourceScopeSchema.options.map((scope) =>
              this.renderSourceToggle(scope),
            )}
          </div>
        </div>
        ${
          this.issues.length === 0
            ? nothing
            : html`<div class="skill-issues" role="status">
                ${this.issues.length} skill load
                issue${this.issues.length === 1 ? '' : 's'}:
                ${this.issues.map((issue) => issue.message).join('; ')}
              </div>`
        }
        ${
          this.skills.length === 0
            ? html`<div class="empty-state">No skills found</div>`
            : ActiveSkillSourceScopeSchema.options.flatMap((scope) => {
                const items = groups.get(scope);
                return items
                  ? [
                      html`<div class="category-section">
                        ${renderSettingsSectionHeading({
                          icon: 'wand-magic-sparkles',
                          title: `${SOURCE_LABELS[scope]} (${items.length})`,
                          description: `Skills discovered from ${scope} sources.`,
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
