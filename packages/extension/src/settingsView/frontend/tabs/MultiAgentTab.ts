/** Multi-agent teams, coordination toggles, and reliability tuning. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

// Web Awesome icon bundle (side-effect import)
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/input/input.js';

// Local imports - shared utils
import { createEvent } from '@shared/utils/events';

// Local imports - shared schemas
import {
  AGENT_MODE_PRESETS,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import type { NumberVscodeSetting } from '@shared/schemas/settingsViewMessages';
import {
  NESTED_DELEGATION_DEPTH_RANGE,
  clampNestedDelegationDepth,
} from '@shared/constants/delegationPolicy';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';
import type WaCheckbox from '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';

function clampSetting(value: number, min?: number, max?: number): number {
  let result = value;
  if (min != null) result = Math.max(min, result);
  if (max != null) result = Math.min(max, result);
  return result;
}

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
        outline-offset: 1px;
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
        align-items: center;
        justify-content: center;
        padding: var(--wa-space-3xs);
        color: var(--color-text-secondary);
        background: none;
        border: none;
        border-radius: var(--border-radius);
        cursor: pointer;
        font-size: var(--font-size-sm);
        z-index: 10;
      }

      .preset-delete-btn:hover {
        color: var(--wa-color-danger-on-quiet);
      }

      .preset-delete-btn:focus-visible {
        outline: var(--border-thin) solid var(--wa-color-focus);
        outline-offset: 1px;
        border-radius: var(--border-radius-small);
      }

      .preset-card:hover .preset-delete-btn {
        display: inline-flex;
      }

      /* Reliability settings */
      .reliability-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        padding: var(--wa-space-2xs) 0;
      }

      .reliability-row label {
        min-width: 140px;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
      }

      .reliability-input {
        width: 80px;
      }

      .reliability-unit {
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      .reliability-description {
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        margin: 0;
        padding-left: calc(140px + var(--wa-space-xs));
      }
    `,
  ];

  @property({ attribute: false }) allowOrchestratorKill = true;
  @property({ attribute: false }) detachSubagentsOnStop = false;
  @property({ attribute: false }) worktreeSupport = false;
  @property({ attribute: false }) nestedDelegationMaxDepth =
    NESTED_DELEGATION_DEPTH_RANGE.default;
  @property({ attribute: false }) reliabilitySettings: NumberVscodeSetting[] =
    [];
  @property({ attribute: false }) customPresets: AgentModePreset[] = [];
  @state() private activePresetId: string | null = null;

  private emitToggle(eventName: string, event: Event): void {
    const target = event.target as WaCheckbox | null;
    this.dispatchEvent(
      createEvent(eventName, { enabled: Boolean(target?.checked) }),
    );
  }

  private handleNestedDelegationMaxDepthChange(input: WaInput): void {
    const parsed = Number(input.value);
    if (Number.isNaN(parsed)) {
      input.value = String(this.nestedDelegationMaxDepth);
      return;
    }
    const clamped = clampNestedDelegationDepth(parsed);
    if (clamped !== parsed) input.value = String(clamped);
    this.dispatchEvent(
      createEvent('nested-delegation-max-depth-change', { value: clamped }),
    );
  }

  private handlePresetClick(preset: AgentModePreset): void {
    this.activePresetId = preset.id;
    this.dispatchEvent(
      createEvent('apply-agent-mode-preset', { presetId: preset.id }),
    );
  }

  private handleDeletePreset(event: Event, preset: AgentModePreset): void {
    event.stopPropagation();
    this.dispatchEvent(
      createEvent('delete-agent-mode-preset', { presetId: preset.id }),
    );
  }

  private handleReliabilityChange(
    setting: NumberVscodeSetting,
    input: WaInput,
  ): void {
    const parsed = Number(input.value);
    if (Number.isNaN(parsed)) {
      input.value = String(setting.value);
      return;
    }
    const value = clampSetting(parsed, setting.min, setting.max);
    if (value !== parsed) input.value = String(value);
    this.dispatchEvent(
      createEvent('reliability-setting-change', { key: setting.key, value }),
    );
  }

  private isOrchestratorAgent(name: string): boolean {
    return name.toLowerCase().includes('orchestrator');
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
        class="preset-card ${isActive ? 'active' : ''}"
        @click=${() => this.handlePresetClick(preset)}
        title="Apply ${preset.name} team"
      >
        <div class="preset-card-header">
          <wa-icon
            library="texra"
            name=${preset.icon.replace('codicon-', '')}
            class="preset-card-icon"
          ></wa-icon>
          <span class="preset-card-name">${preset.name}</span>
          ${isActive
            ? html`<wa-tag
                class="preset-active-badge"
                variant="brand"
                size="small"
              >
                <wa-icon library="texra" name="check"></wa-icon> Active
              </wa-tag>`
            : nothing}
        </div>
        <p class="preset-card-description">${preset.description}</p>
        ${orchestratorAgents.length > 0
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
                      >🎯</span
                    >
                    ${name}
                  </wa-tag>
                `,
              )}
            </div>`
          : nothing}
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
        ${deletable
          ? html`<button
              class="preset-delete-btn"
              @click=${(e: Event) => this.handleDeletePreset(e, preset)}
              title="Delete team"
            >
              <wa-icon library="texra" name="trash"></wa-icon>
            </button>`
          : nothing}
      </div>
    `;
  }

  private renderReliabilitySetting(
    setting: NumberVscodeSetting,
  ): TemplateResult {
    return html`
      <div class="reliability-row">
        <label>${setting.label}</label>
        <wa-input
          class="reliability-input"
          type="number"
          .value=${String(setting.value)}
          min=${setting.min ?? nothing}
          max=${setting.max ?? nothing}
          @change=${(e: Event) =>
            this.handleReliabilityChange(setting, e.target as WaInput)}
        ></wa-input>
        ${setting.unit
          ? html`<span class="reliability-unit">${setting.unit}</span>`
          : nothing}
      </div>
      <p class="reliability-description">${setting.description}</p>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="multi-agent-container tab-content-container">
        <div class="settings-reminder">
          <wa-icon
            library="texra"
            name="organization"
            class="settings-reminder-icon"
          ></wa-icon>
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
          <wa-checkbox
            ?checked=${this.allowOrchestratorKill}
            @change=${(e: Event) =>
              this.emitToggle('allow-orchestrator-kill-toggle', e)}
          >
            Let orchestrator stop agents early
          </wa-checkbox>
          <p class="text-secondary setting-description">
            The orchestrator can cancel agents that are stuck or no longer
            needed. Turn this off if you want every agent to finish no matter
            what.
          </p>
        </div>

        <div class="setting-block">
          <wa-checkbox
            ?checked=${this.detachSubagentsOnStop}
            @change=${(e: Event) =>
              this.emitToggle('detach-subagents-on-stop-toggle', e)}
          >
            Keep agents running if I stop the orchestrator
          </wa-checkbox>
          <p class="text-secondary setting-description">
            Normally everything stops when you stop the orchestrator. Turn this
            on to let agents that are mid-task finish on their own.
          </p>
        </div>

        <div class="setting-block">
          <wa-checkbox
            ?checked=${this.worktreeSupport}
            @change=${(e: Event) =>
              this.emitToggle('worktree-support-toggle', e)}
          >
            Allow agents to work in git worktrees
          </wa-checkbox>
          <p class="text-secondary setting-description">
            When enabled, delegated agents can operate in git worktrees outside
            the main workspace. All tool calls within the subagent automatically
            use the worktree as their root directory.
          </p>
        </div>

        <div class="setting-block">
          <div class="reliability-row">
            <label>Max delegation depth</label>
            <wa-input
              class="reliability-input"
              type="number"
              .value=${String(this.nestedDelegationMaxDepth)}
              min=${NESTED_DELEGATION_DEPTH_RANGE.min}
              max=${NESTED_DELEGATION_DEPTH_RANGE.max}
              @change=${(e: Event) =>
                this.handleNestedDelegationMaxDepthChange(e.target as WaInput)}
            ></wa-input>
          </div>
          <p class="reliability-description">
            Depth 1 (default): only the top-level orchestrator may delegate;
            subagents cannot delegate further. Depth 2 lets a sub-orchestrator
            delegate once more (orchestrator → sub-orchestrator → leaf). Higher
            values allow deeper chains.
          </p>
        </div>

        ${this.reliabilitySettings.length > 0
          ? html`
              <h3>Reliability</h3>
              <p class="text-secondary setting-description">
                Tweak how long sessions handle retries and context limits.
              </p>
              <div class="setting-block">
                ${this.reliabilitySettings.map((s) =>
                  this.renderReliabilitySetting(s),
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'multi-agent-tab': MultiAgentTab;
  }
}
