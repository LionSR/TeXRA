/**
 * MultiAgentTab component - multi-agent settings for the settings view.
 * Contains agent mode presets (built-in + custom) for quick configuration,
 * the auto-approve toggle for agent delegation proposals,
 * and reliability settings.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, designTokens, commonViewStyles } from '@shared/styles';

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

@customElement('multi-agent-tab')
export class MultiAgentTab extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .multi-agent-container {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-medium);
      }

      .setting-block {
        padding: var(--spacing-medium);
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: var(--border-radius);
      }

      .setting-description {
        margin: var(--spacing-small) 0 0 0;
        font-size: var(--font-size-sm);
      }

      /* Preset cards */
      .preset-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: var(--spacing-medium);
      }

      .preset-card {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-small);
        padding: var(--spacing-medium);
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        cursor: pointer;
        transition:
          border-color var(--transition-fast),
          background-color var(--transition-fast);
      }

      .preset-card:hover {
        border-color: var(--vscode-focusBorder);
        background-color: var(
          --vscode-list-hoverBackground,
          rgba(128, 128, 128, 0.1)
        );
      }

      .preset-card:focus-visible {
        outline: var(--border-thin) solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .preset-card.active {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(
          --vscode-list-activeSelectionForeground,
          var(--vscode-foreground)
        );
        border-color: var(--vscode-focusBorder);
      }

      .preset-card.active .preset-card-name,
      .preset-card.active .preset-card-description,
      .preset-card.active .preset-card-icon,
      .preset-card.active .preset-active-badge {
        color: inherit;
      }

      .preset-active-badge {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        padding: var(--border-thin) var(--border-radius-large);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--vscode-focusBorder);
        background: color-mix(
          in srgb,
          var(--vscode-focusBorder) 15%,
          transparent
        );
        border-radius: var(--border-radius-medium);
      }

      .preset-active-badge .codicon {
        font-size: var(--font-size-xs);
      }

      .preset-card-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
      }

      .preset-card-icon {
        font-size: var(--font-size-lg);
        color: var(--vscode-focusBorder);
        flex-shrink: 0;
      }

      .preset-card-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--vscode-foreground);
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

      .preset-card-agents {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-small);
        margin-top: var(--spacing-tiny);
      }

      .preset-agent-badge {
        display: inline-block;
        padding: var(--border-thin) var(--border-radius-large);
        font-size: var(--font-size-xs);
        color: var(--vscode-badge-foreground);
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.15));
        border-radius: var(--border-radius);
      }

      .preset-delete-btn {
        position: absolute;
        top: var(--spacing-small);
        right: var(--spacing-small);
        display: none;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-tiny);
        color: var(--color-text-secondary);
        background: none;
        border: none;
        border-radius: var(--border-radius);
        cursor: pointer;
        font-size: var(--font-size-sm);
      }

      .preset-delete-btn:hover {
        color: var(--vscode-errorForeground);
      }

      .preset-delete-btn:focus-visible {
        outline: var(--border-thin) solid var(--vscode-focusBorder);
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
        gap: var(--spacing-medium);
        padding: var(--spacing-small) 0;
      }

      .reliability-row label {
        min-width: 140px;
        font-size: var(--font-size-sm);
        color: var(--vscode-foreground);
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
        padding-left: calc(140px + var(--spacing-medium));
      }
    `,
  ];

  @property({ attribute: false }) superYoloEnabled = false;
  @property({ attribute: false }) toggleDisabled = true;
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
    const target = event.target as HTMLInputElement | null;
    this.dispatchEvent(
      createEvent(eventName, { enabled: Boolean(target?.checked) }),
    );
  }

  private handleToggle(event: Event): void {
    this.emitToggle('super-yolo-toggle', event);
  }

  private handleKillToggle(event: Event): void {
    this.emitToggle('allow-orchestrator-kill-toggle', event);
  }

  private handleDetachToggle(event: Event): void {
    this.emitToggle('detach-subagents-on-stop-toggle', event);
  }

  private handleWorktreeSupportToggle(event: Event): void {
    this.emitToggle('worktree-support-toggle', event);
  }

  private handleNestedDelegationMaxDepthChange(input: HTMLInputElement): void {
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
    input: HTMLInputElement,
  ): void {
    const parsed = Number(input.value);
    if (Number.isNaN(parsed)) {
      input.value = String(setting.value);
      return;
    }
    let value = parsed;
    if (setting.min != null) value = Math.max(setting.min, value);
    if (setting.max != null) value = Math.min(setting.max, value);
    if (value !== parsed) input.value = String(value);
    this.dispatchEvent(
      createEvent('reliability-setting-change', { key: setting.key, value }),
    );
  }

  private renderPresetCard(
    preset: AgentModePreset,
    deletable: boolean,
  ): TemplateResult {
    const allAgents = [...preset.toolUseAgents, ...preset.workflowAgents];
    const isActive = this.activePresetId === preset.id;
    return html`
      <div
        class="preset-card ${isActive ? 'active' : ''}"
        @click=${() => this.handlePresetClick(preset)}
        title="Apply ${preset.name} team"
      >
        <div class="preset-card-header">
          <span class="codicon ${preset.icon} preset-card-icon"></span>
          <span class="preset-card-name">${preset.name}</span>
          ${isActive
            ? html`<span class="preset-active-badge">
                <span class="codicon codicon-check"></span> Active
              </span>`
            : nothing}
        </div>
        <p class="preset-card-description">${preset.description}</p>
        <div class="preset-card-agents">
          ${allAgents.map(
            (name) => html`<span class="preset-agent-badge">${name}</span>`,
          )}
        </div>
        ${deletable
          ? html`<button
              class="preset-delete-btn"
              @click=${(e: Event) => this.handleDeletePreset(e, preset)}
              title="Delete team"
            >
              <span class="codicon codicon-trash"></span>
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
        <vscode-textfield
          class="reliability-input"
          type="number"
          .value=${String(setting.value)}
          min=${setting.min ?? nothing}
          max=${setting.max ?? nothing}
          @change=${(e: Event) =>
            this.handleReliabilityChange(setting, e.target as HTMLInputElement)}
        ></vscode-textfield>
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
          <span
            class="codicon codicon-organization settings-reminder-icon"
          ></span>
          <div class="settings-reminder-title">Multi-agent workflow</div>
          <div class="settings-reminder-description">
            The orchestrator reads your paper and hands work to specialized
            agents for writing, derivations, numerical experiments, citations,
            figures, and more.
          </div>
          <ol class="settings-reminder-list settings-reminder-description">
            <li>
              <span class="settings-reminder-step">1</span>
              <span
                ><strong>Pick a team</strong> below that matches your field.
                This enables and configures the right specialized agents for
                you.</span
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
                reject. Or turn on auto-approve below.</span
              >
            </li>
          </ol>
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
          <vscode-checkbox
            ?checked=${this.superYoloEnabled}
            ?disabled=${this.toggleDisabled}
            @change=${this.handleToggle}
          >
            Auto-approve delegated tasks
          </vscode-checkbox>
          <p class="text-secondary setting-description">
            Let the orchestrator run without waiting for your approval on each
            task. Use the rocket button
            <span class="codicon codicon-rocket"></span> in Progress to turn
            this on for a single stream.
          </p>
        </div>

        <div class="setting-block">
          <vscode-checkbox
            ?checked=${this.allowOrchestratorKill}
            @change=${this.handleKillToggle}
          >
            Let orchestrator stop agents early
          </vscode-checkbox>
          <p class="text-secondary setting-description">
            The orchestrator can cancel agents that are stuck or no longer
            needed. Turn this off if you want every agent to finish no matter
            what.
          </p>
        </div>

        <div class="setting-block">
          <vscode-checkbox
            ?checked=${this.detachSubagentsOnStop}
            @change=${this.handleDetachToggle}
          >
            Keep agents running if I stop the orchestrator
          </vscode-checkbox>
          <p class="text-secondary setting-description">
            Normally everything stops when you stop the orchestrator. Turn this
            on to let agents that are mid-task finish on their own.
          </p>
        </div>

        <div class="setting-block">
          <vscode-checkbox
            ?checked=${this.worktreeSupport}
            @change=${this.handleWorktreeSupportToggle}
          >
            Allow agents to work in git worktrees
          </vscode-checkbox>
          <p class="text-secondary setting-description">
            When enabled, delegated agents can operate in git worktrees outside
            the main workspace. All tool calls within the subagent automatically
            use the worktree as their root directory.
          </p>
        </div>

        <div class="setting-block">
          <div class="reliability-row">
            <label>Max delegation depth</label>
            <vscode-textfield
              class="reliability-input"
              type="number"
              .value=${String(this.nestedDelegationMaxDepth)}
              min=${NESTED_DELEGATION_DEPTH_RANGE.min}
              max=${NESTED_DELEGATION_DEPTH_RANGE.max}
              @change=${(e: Event) =>
                this.handleNestedDelegationMaxDepthChange(
                  e.target as HTMLInputElement,
                )}
            ></vscode-textfield>
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
