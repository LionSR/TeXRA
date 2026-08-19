/** Multi-agent teams and coordination toggles. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

// Web Awesome icon bundle (side-effect import)
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  AGENT_MODE_PRESETS,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  type AgentModePreset,
} from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import {
  renderSettingsNumberRow,
  renderSettingsSectionHeading,
} from '@shared/wa/settingsSection';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - catalog-driven settings rows
import {
  postStateSetting,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';

@customElement('multi-agent-tab')
export class MultiAgentTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .multi-agent-container {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-xs);
      }

      .setting-number-input {
        width: 80px;
      }

      /* Team cards */
      .preset-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: var(--wa-space-xs);
      }

      .preset-card {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        background-color: var(--wa-color-neutral-fill-quiet);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        cursor: pointer;
      }

      .preset-card:hover {
        border-color: var(--wa-color-focus);
      }

      .preset-card.active {
        background-color: var(--wa-color-brand-fill-quiet);
        color: var(--wa-color-list-active-fg);
        border-color: var(--wa-color-focus);
      }

      .preset-card.active .preset-card-name,
      .preset-card.active .preset-card-description,
      .preset-card.active .preset-card-icon {
        color: inherit;
      }

      wa-tag.preset-active-badge wa-icon {
        font-size: var(--font-size-xs);
      }

      .preset-card-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
      }

      .preset-card-icon {
        font-size: var(--font-size-lg);
        color: var(--wa-color-focus);
        flex-shrink: 0;
      }

      .preset-card-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--wa-color-text-normal);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .preset-card-description {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
        margin: 0;
      }

      .preset-card-agents,
      .preset-card-orchestrators {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-3xs);
        margin-top: 0;
      }

      /* Compact agent pills — WA's size="s" is still too chunky for a
         dense grid of badges. Override the chrome-padding part to halve
         vertical padding and trim the font size. */
      wa-tag.preset-agent-badge::part(base),
      wa-tag.preset-active-badge::part(base) {
        padding: 0 var(--wa-space-2xs);
        min-height: 18px;
        font-size: var(--font-size-xs);
        line-height: 1.2;
      }

      wa-tag.preset-agent-badge--orchestrator {
        font-weight: var(--font-weight-semibold);
      }

      .preset-orchestrator-icon {
        font-size: var(--font-size-xs);
        line-height: 1;
      }

      .preset-delete-btn {
        position: absolute;
        inset-block-start: var(--wa-space-2xs);
        inset-inline-end: var(--wa-space-2xs);
        opacity: 0;
        /* Destructive and invisible: a tap on the card corner must not delete a
           team. Keyboard focus is unaffected, and focusing reveals the button
           through :focus-within below. */
        pointer-events: none;
        z-index: 10;
      }

      .preset-delete-btn::part(base) {
        color: var(--color-text-secondary);
      }

      .preset-delete-btn::part(base):hover {
        color: var(--wa-color-danger-on-quiet);
      }

      /* Part-piercing: a shadow-scoped :focus-visible cannot reach wa-button's
         inner control, so this rule is the only ring it gets. */
      .preset-delete-btn:focus-visible::part(base) {
        outline: var(--focus-ring-width) solid var(--wa-color-focus);
        outline-offset: var(--focus-ring-offset);
        border-radius: var(--border-radius-small);
      }

      .preset-card:hover .preset-delete-btn,
      .preset-card:focus-within .preset-delete-btn {
        opacity: var(--opacity-full);
        pointer-events: auto;
      }
    `,
  ];

  @property({ attribute: false }) allowOrchestratorKill = true;
  @property({ attribute: false }) detachSubagentsOnStop = false;
  @property({ attribute: false }) worktreeSupport = false;
  @property({ attribute: false }) childRunConcurrencyBudget =
    CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue;
  /** Parent-owned acknowledgement generation; changes force a re-render even when all field values are unchanged. */
  @property({ attribute: false }) ackGeneration = 0;
  @property({ attribute: false }) customPresets: AgentModePreset[] = [];
  /** Agent names that carry delegation tools, computed backend-side from the registry. */
  @property({ attribute: false }) orchestratorAgents: string[] = [];
  @state() private activePresetId: string | null = null;

  private handlePresetClick(preset: AgentModePreset): void {
    this.activePresetId = preset.id;
    postMessage(SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET, {
      presetId: preset.id,
    });
  }

  private handlePresetKey(event: KeyboardEvent, preset: AgentModePreset): void {
    if (event.key === 'Enter' || event.key === ' ') {
      // Ignore Enter/Space that bubbled up from the nested delete button —
      // that control owns its own click/keydown activation and must not
      // also apply the preset it's being deleted from.
      if ((event.target as HTMLElement | null)?.closest('.preset-delete-btn')) {
        return;
      }
      event.preventDefault();
      this.handlePresetClick(preset);
    }
  }

  private handleDeletePreset(event: Event, preset: AgentModePreset): void {
    event.stopPropagation();
    postMessage(SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET, {
      presetId: preset.id,
    });
  }

  private isOrchestratorAgent(name: string): boolean {
    // Prefer the capability-based list (catches roots like `engineer` that
    // don't carry "orchestrator" in their name); keep the name heuristic as a
    // fallback for presets referencing agents the registry hasn't loaded.
    return (
      this.orchestratorAgents.includes(name) ||
      name.toLowerCase().includes('orchestrator')
    );
  }

  private renderPresetCard(
    preset: AgentModePreset,
    deletable: boolean,
  ): TemplateResult {
    const allAgents = [...preset.agents.toolUse, ...preset.agents.workflow];
    const orchestratorAgents = allAgents.filter((name) =>
      this.isOrchestratorAgent(name),
    );
    const teammateAgents = allAgents.filter(
      (name) => !this.isOrchestratorAgent(name),
    );
    const isActive = this.activePresetId === preset.id;
    return html`
      <div
        class=${classMap({ 'preset-card': true, active: isActive })}
        role="button"
        tabindex="0"
        @click=${() => this.handlePresetClick(preset)}
        @keydown=${(e: KeyboardEvent) => this.handlePresetKey(e, preset)}
        title="Apply ${preset.name} team"
      >
        <div class="preset-card-header">
          ${waIcon(preset.icon, { className: 'preset-card-icon' })}
          <span class="preset-card-name">${preset.name}</span>
          ${
            isActive
              ? html`<wa-tag
                  class="preset-active-badge"
                  variant="brand"
                  size="s"
                >
                  ${waIcon('check')} Active
                </wa-tag>`
              : nothing
          }
        </div>
        <p class="preset-card-description">${preset.description}</p>
        ${
          orchestratorAgents.length > 0
            ? html`<div class="preset-card-orchestrators">
                ${orchestratorAgents.map(
                  (name) => html`
                    <wa-tag
                      class="preset-agent-badge preset-agent-badge--orchestrator"
                      variant="brand"
                      size="s"
                      title="${name} is the orchestrator for this team"
                    >
                      <span class="preset-orchestrator-icon" aria-hidden="true"
                        >${waIcon('bullseye')}</span
                      >
                      <!-- The bullseye is aria-hidden and the tag's title is
                           hover-only, so carry the orchestrator identity as
                           (visually hidden) text. -->
                      <span class="visually-hidden">Orchestrator:</span>
                      ${name}
                    </wa-tag>
                  `,
                )}
              </div>`
            : nothing
        }
        <div class="preset-card-agents">
          ${teammateAgents.map(
            (name) =>
              html`<wa-tag class="preset-agent-badge" variant="neutral" size="s"
                >${name}</wa-tag
              >`,
          )}
        </div>
        ${
          deletable
            ? renderIconActionButton({
                icon: 'trash',
                label: 'Delete team',
                className: 'preset-delete-btn',
                onClick: (e) => this.handleDeletePreset(e, preset),
              })
            : nothing
        }
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div
        class="multi-agent-container tab-content-container"
        data-ack-generation=${this.ackGeneration}
      >
        ${renderSettingsSectionHeading({
          title: 'Available teams',
          description: 'Select a team to activate it.',
          icon: 'users',
        })}

        <div class="preset-grid">
          ${AGENT_MODE_PRESETS.map((p) => this.renderPresetCard(p, false))}
          ${this.customPresets.map((p) => this.renderPresetCard(p, true))}
        </div>

        ${renderSettingsSectionHeading({
          title: 'Team coordination',
          description:
            "Control how the orchestrator works with the rest of the team. It can only use agents and models you've enabled.",
          icon: 'diagram-project',
        })}

        <div class="settings-section">
          ${renderStateSettingToggleRow({
            key: GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
            label: 'Let orchestrator stop agents early',
            description:
              'The orchestrator can cancel agents that are stuck or no longer needed. Turn this off if you want every agent to finish.',
            checked: this.allowOrchestratorKill,
          })}
          ${renderStateSettingToggleRow({
            key: GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
            label: 'Keep agents running after you stop the orchestrator',
            description:
              'Let agents that are already mid-task finish independently.',
            checked: this.detachSubagentsOnStop,
          })}
          ${renderStateSettingToggleRow({
            key: WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
            label: 'Allow agents to work in git worktrees',
            description:
              'Delegated agents can use isolated worktrees, with every tool call rooted in that worktree.',
            checked: this.worktreeSupport,
          })}
          ${renderSettingsNumberRow({
            label: 'Child-run concurrency budget',
            description: CHILD_RUN_CONCURRENCY_BUDGET_SETTING.description,
            value: this.childRunConcurrencyBudget,
            min: CHILD_RUN_CONCURRENCY_BUDGET_SETTING.min,
            max: CHILD_RUN_CONCURRENCY_BUDGET_SETTING.max,
            step: 1,
            onChange: (value) =>
              postStateSetting(CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY, value),
          })}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'multi-agent-tab': MultiAgentTab;
  }
}
