/**
 * MultiAgentTab component - multi-agent settings for the settings view.
 * Contains agent mode presets for quick configuration, the Super YOLO toggle
 * for auto-approving agent delegation proposals, and reliability settings.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, designTokens, commonViewStyles } from '@shared/styles';

// Local imports - shared utils
import { createEvent } from '@shared/utils/events';

// Local imports - shared schemas
import type { NumberVscodeSetting } from '@shared/schemas/settingsViewMessages';
import {
  AGENT_MODE_PRESETS,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';

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
        font-size: var(--font-size-small);
      }

      /* Preset cards */
      .preset-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: var(--spacing-medium);
      }

      .preset-card {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-small);
        padding: var(--spacing-medium);
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        cursor: pointer;
        transition:
          border-color 0.15s ease,
          background-color 0.15s ease;
      }

      .preset-card:hover {
        border-color: var(--vscode-focusBorder);
        background-color: var(
          --vscode-list-hoverBackground,
          rgba(128, 128, 128, 0.1)
        );
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
        font-weight: 500;
        color: var(--vscode-foreground);
      }

      .preset-card-description {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        line-height: 1.4;
        margin: 0;
      }

      .preset-card-agents {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: var(--spacing-tiny);
      }

      .preset-agent-badge {
        display: inline-block;
        padding: 1px 6px;
        font-size: 10px;
        color: var(--color-text-secondary);
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.15));
        border-radius: var(--border-radius);
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
  @property({ attribute: false }) reliabilitySettings: NumberVscodeSetting[] =
    [];

  private handleToggle(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.dispatchEvent(
      createEvent('super-yolo-toggle', { enabled: Boolean(target?.checked) }),
    );
  }

  private handlePresetClick(preset: AgentModePreset): void {
    this.dispatchEvent(
      createEvent('apply-agent-mode-preset', { presetId: preset.id }),
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

  private renderPresetCard(preset: AgentModePreset): TemplateResult {
    const allAgents = [...preset.toolUseAgents, ...preset.workflowAgents];
    return html`
      <div
        class="preset-card"
        @click=${() => this.handlePresetClick(preset)}
        title="Apply ${preset.name} preset"
      >
        <div class="preset-card-header">
          <span class="codicon ${preset.icon} preset-card-icon"></span>
          <span class="preset-card-name">${preset.name}</span>
        </div>
        <p class="preset-card-description">${preset.description}</p>
        <div class="preset-card-agents">
          ${allAgents.map(
            (name) => html`<span class="preset-agent-badge">${name}</span>`,
          )}
        </div>
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
        <h3>Mode Presets</h3>

        <p class="text-secondary setting-description">
          Apply a preset to quickly configure which agents are enabled for your
          workflow. This updates the Agents tab selection.
        </p>

        <div class="preset-grid">
          ${AGENT_MODE_PRESETS.map((p) => this.renderPresetCard(p))}
        </div>

        <h3>Agent Delegation</h3>

        <p class="text-secondary setting-description">
          Models and agents enabled in the Models and Agents tabs are displayed
          to the orchestrator agent as available options for delegation.
        </p>

        <div class="setting-block">
          <vscode-checkbox
            ?checked=${this.superYoloEnabled}
            ?disabled=${this.toggleDisabled}
            @change=${this.handleToggle}
          >
            Enable Super YOLO mode
          </vscode-checkbox>
          <p class="text-secondary setting-description">
            When enabled, allows per-stream auto-approval of agent delegation
            proposals. Use the rocket button in the progress view toolbar to
            activate Super YOLO for individual streams.
          </p>
        </div>

        ${this.reliabilitySettings.length > 0
          ? html`
              <h3>Reliability</h3>
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
