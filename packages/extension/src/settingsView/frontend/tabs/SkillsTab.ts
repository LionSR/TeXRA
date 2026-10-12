import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';
import {
  AGENT_SKILLS_CONFIG_KEY,
  ActiveSkillSourceScopeSchema,
  type ActiveSkillSourceScope,
  type SkillDisplayIssue,
  type SkillDisplayItem,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { commonViewStyles, designTokens } from '@ui/styles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { renderSettingsToggleRow } from '@ui/wa/settingsSection';
import { pluralize } from '@utils/text/stringUtils';
import {
  postStateSetting,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';
import { catalogDetailStyles } from '../components/shared/catalogDetailStyles';
import type { SettingsCatalogItem } from '../components/shared/SettingsCatalog';
import '../components/shared/SettingsCatalog';
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
    catalogDetailStyles,
    css`
      :host {
        display: block;
      }
      settings-catalog {
        /* Leave room for the master switch and the source/issue disclosures. */
        --catalog-height: clamp(12rem, calc(100dvh - 30rem), 24rem);
      }
      .skill-path {
        overflow-wrap: anywhere;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }
      .skill-issues {
        display: block;
        font-size: var(--font-size-sm);
        margin-block: var(--wa-space-xs);
      }
      .skill-issues ul {
        margin: 0;
        padding-inline-start: var(--wa-space-m);
        overflow-wrap: anywhere;
      }
      .skill-sources {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
        gap: var(--wa-space-xs);
      }
      .skill-source-settings {
        display: block;
        margin-block-start: var(--wa-space-xs);
      }
    `,
  ];
  @property({ type: Boolean }) masterEnabled = false;
  @property({ attribute: false }) disabledSkills: string[] = [];
  @property({ attribute: false }) disabledSources: ActiveSkillSourceScope[] =
    [];
  @property({ attribute: false }) skills: SkillDisplayItem[] = [];
  @property({ attribute: false }) issues: SkillDisplayIssue[] = [];
  @state() private selectedKey: string | null = null;

  private toggleValue<T>(
    values: readonly T[],
    value: T,
    enabled: boolean,
  ): T[] {
    return enabled
      ? values.filter((candidate) => candidate !== value)
      : [...new Set([...values, value])];
  }

  private setEnabled(item: SkillDisplayItem, enabled: boolean): void {
    postStateSetting(
      WorkspaceStateKey.DISABLED_SKILLS,
      this.toggleValue(this.disabledSkills, item.name, enabled),
    );
  }

  private renderSourceToggle(scope: ActiveSkillSourceScope): TemplateResult {
    return html`<wa-switch
      id=${`skill-source-${scope}`}
      .checked=${live(!this.disabledSources.includes(scope))}
      ?disabled=${!this.masterEnabled}
      @change=${(event: Event) => postStateSetting(WorkspaceStateKey.DISABLED_SKILL_SOURCES, this.toggleValue(this.disabledSources, scope, (event.target as WaSwitch).checked))}
      >Use ${SOURCE_LABELS[scope].toLowerCase()} skills</wa-switch
    >`;
  }

  private catalogItem(item: SkillDisplayItem): SettingsCatalogItem {
    return {
      key: item.path,
      name: item.name,
      description: item.description,
      group: SOURCE_LABELS[item.scope],
      searchText: item.path,
      control: renderIconActionButton({
        id: `skill-enabled-${encodeURIComponent(item.path)}`,
        className: 'catalog-row-toggle',
        icon: item.enabled ? 'eye' : 'eye-slash',
        label: `Use ${item.name}`,
        pressed: item.enabled,
        tooltip: item.enabled ? 'Available to agents' : 'Unavailable to agents',
        disabled:
          !this.masterEnabled || this.disabledSources.includes(item.scope),
        onClick: (event) => {
          event.stopPropagation();
          this.setEnabled(item, !item.enabled);
        },
      }),
    };
  }

  private renderDetail(item: SkillDisplayItem): TemplateResult {
    return html`<section slot="detail" aria-labelledby="skill-detail-name">
      <div class="catalog-detail-header">
        <h3 class="catalog-detail-name" id="skill-detail-name">${item.name}</h3>
        <wa-tag size="s">${SOURCE_LABELS[item.scope]}</wa-tag>
      </div>
      <p class="catalog-detail-description">${item.description}</p>
      ${renderSettingsToggleRow({
        label: 'Available to agents',
        checked: item.enabled,
        disabled:
          !this.masterEnabled || this.disabledSources.includes(item.scope),
        onChange: (event: Event) =>
          this.setEnabled(item, (event.target as WaSwitch).checked),
      })}
      <dl class="catalog-detail-meta">
        <dt class="catalog-detail-meta-label">Instructions</dt>
        <dd class="catalog-detail-meta-value skill-path">
          <code>${item.path}</code>
        </dd>
      </dl>
    </section>`;
  }

  override render(): TemplateResult {
    const selected =
      this.skills.find((item) => item.path === this.selectedKey) ??
      this.skills[0];
    return html`
      <div class="settings-section">
        ${renderStateSettingToggleRow({ key: AGENT_SKILLS_CONFIG_KEY, checked: this.masterEnabled })}
      </div>
      <settings-catalog
        label="Skills"
        actionLabel="Available"
        .items=${this.skills.map((item) => this.catalogItem(item))}
        .selectedKey=${this.selectedKey}
        @catalog-select=${(event: CustomEvent<string | null>) => {
          this.selectedKey = event.detail;
        }}
      >
        ${selected ? this.renderDetail(selected) : nothing}
      </settings-catalog>
      ${
        this.issues.length
          ? html`<wa-details
              class="collapsible-quiet skill-issues"
              summary=${`${this.issues.length} skill load ${pluralize(this.issues.length, 'issue')}`}
              ><ul>
                ${this.issues.map((issue) => html`<li>${issue.message}</li>`)}
              </ul></wa-details
            >`
          : nothing
      }
      <wa-details
        class="collapsible-quiet skill-source-settings"
        summary="Skill sources"
      >
        <div class="skill-sources">
          ${ActiveSkillSourceScopeSchema.options.map((scope) => this.renderSourceToggle(scope))}
        </div>
      </wa-details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'skills-tab': SkillsTab;
  }
}
