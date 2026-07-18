/** Multi-agent teams and coordination toggles. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

// Web Awesome icon bundle (side-effect import)
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/button/button.js';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - shared schemas
import {
  AGENT_MODE_PRESETS,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

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

      .setting-block {
        padding: var(--wa-space-xs);
        background-color: var(--wa-color-neutral-fill-quiet);
        border-radius: var(--border-radius);
      }

      .setting-description {
        margin: var(--wa-space-2xs) 0 0 0;
        font-size: var(--font-size-sm);
      }

      .multi-agent-reminder-steps {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: var(--wa-space-2xs) var(--wa-space-s);
        margin-top: var(--wa-space-3xs);
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

      .preset-card:focus-visible {
        outline: var(--border-thin) solid var(--wa-color-focus);
        outline-offset: var(--border-thin);
      }

      .preset-card.active {
        background-color: var(--wa-color-brand-fill-quiet);
        color: var(
          --texra-list-activeSelectionForeground,
          var(--wa-color-text-normal)
        );
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

      /* Compact agent pills — WA's size="small" is still too chunky for a
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
        top: var(--wa-space-2xs);
        right: var(--wa-space-2xs);
        display: none;
        z-index: 10;
      }

      .preset-delete-btn::part(base) {
        color: var(--color-text-secondary);
      }

      .preset-delete-btn::part(base):hover {
        color: var(--wa-color-danger-on-quiet);
      }

      .preset-delete-btn:focus-visible::part(base) {
        outline: var(--border-thin) solid var(--wa-color-focus);
        outline-offset: var(--border-thin);
        border-radius: var(--border-radius-small);
      }

      .preset-card:hover .preset-delete-btn {
        display: inline-flex;
      }
    `,
  ];

  @property({ attribute: false }) allowOrchestratorKill = true;
  @property({ attribute: false }) detachSubagentsOnStop = false;
  @property({ attribute: false }) worktreeSupport = false;
  @property({ attribute: false }) customPresets: AgentModePreset[] = [];
  /** Agent names that carry delegation tools, computed backend-side from the registry. */
  @property({ attribute: false }) orchestratorAgents: string[] = [];
  @state() private activePresetId: string | null = null;

  private postToggle(command: string, event: Event): void {
    const target = event.target as WaSwitch | null;
    postMessage(command, { enabled: Boolean(target?.checked) });
  }

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
    const allAgents = [...preset.toolUseAgents, ...preset.workflowAgents];
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
                  size="small"
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
                      size="small"
                      title="${name} is the orchestrator for this team"
                    >
                      <span class="preset-orchestrator-icon" aria-hidden="true"
                        >${waIcon('bullseye')}</span
                      >
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
              html`<wa-tag
                class="preset-agent-badge"
                variant="neutral"
                size="small"
                >${name}</wa-tag
              >`,
          )}
        </div>
        ${
          deletable
            ? html`<wa-button
                class="preset-delete-btn"
                appearance="plain"
                variant="neutral"
                size="small"
                @click=${(e: Event) => this.handleDeletePreset(e, preset)}
                title="Delete team"
                aria-label="Delete team"
              >
                ${waIcon('trash')}
              </wa-button>`
            : nothing
        }
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="multi-agent-container tab-content-container">
        <div class="settings-reminder">
          ${waIcon('organization', { className: 'settings-reminder-icon' })}
          <div class="settings-reminder-body">
            <div class="settings-reminder-title">Multi-agent workflow</div>
            <div class="settings-reminder-description">
              The orchestrator reads your paper and hands work to specialized
              agents for writing, derivations, numerical experiments, citations,
              figures, and more.
            </div>
            <ol
              class="settings-reminder-list settings-reminder-description multi-agent-reminder-steps"
            >
              <li>
                <span class="settings-reminder-step">1</span>
                <span
                  ><strong>Pick a team</strong> below that matches your field.
                  This enables and configures the right specialized agents for
                  you. You can also add or remove individual agents in the
                  <strong>Agents</strong> tab.</span
                >
              </li>
              <li>
                <span class="settings-reminder-step">2</span>
                <span
                  ><strong>Select orchestrator</strong> from the agent dropdown
                  (look for the target icon), then click Execute.</span
                >
              </li>
              <li>
                <span class="settings-reminder-step">3</span>
                <span
                  ><strong>Approve tasks</strong> in Progress as they come in —
                  press <strong>y</strong> to approve or <strong>n</strong> to
                  reject. Use the rocket button in Progress to let one stream
                  run without task-by-task approval.</span
                >
              </li>
            </ol>
          </div>
        </div>

        <h3>Multi-Agent Teams</h3>

        <p class="text-secondary setting-description">
          Click one to activate it. You can make your own teams in the Agents
          tab.
        </p>

        <div class="preset-grid">
          ${AGENT_MODE_PRESETS.map((p) => this.renderPresetCard(p, false))}
          ${this.customPresets.map((p) => this.renderPresetCard(p, true))}
        </div>

        <h3>Team Coordination</h3>

        <p class="text-secondary setting-description">
          Control how the orchestrator works with the rest of the team. It can
          only use agents and models you've turned on in the Models and Agents
          tabs.
        </p>

        <div class="setting-block">
          <wa-switch
            ?checked=${this.allowOrchestratorKill}
            @change=${(e: Event) =>
              this.postToggle(
                SETTINGS_VIEW_COMMANDS.SET_ALLOW_ORCHESTRATOR_KILL,
                e,
              )}
          >
            Let orchestrator stop agents early
          </wa-switch>
          <p class="text-secondary setting-description">
            The orchestrator can cancel agents that are stuck or no longer
            needed. Turn this off if you want every agent to finish no matter
            what.
          </p>
        </div>

        <div class="setting-block">
          <wa-switch
            ?checked=${this.detachSubagentsOnStop}
            @change=${(e: Event) =>
              this.postToggle(
                SETTINGS_VIEW_COMMANDS.SET_DETACH_SUBAGENTS_ON_STOP,
                e,
              )}
          >
            Keep agents running if I stop the orchestrator
          </wa-switch>
          <p class="text-secondary setting-description">
            Normally everything stops when you stop the orchestrator. Turn this
            on to let agents that are mid-task finish on their own.
          </p>
        </div>

        <div class="setting-block">
          <wa-switch
            ?checked=${this.worktreeSupport}
            @change=${(e: Event) =>
              this.postToggle(
                SETTINGS_VIEW_COMMANDS.SET_GIT_WORKTREE_SUPPORT,
                e,
              )}
          >
            Allow agents to work in git worktrees
          </wa-switch>
          <p class="text-secondary setting-description">
            When enabled, delegated agents can operate in git worktrees outside
            the main workspace. All tool calls within the subagent automatically
            use the worktree as their root directory.
          </p>
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
