/**
 * MultiAgentTab component - multi-agent settings for the settings view.
 * Contains the Super YOLO toggle for auto-approving agent delegation proposals
 * and reliability settings (compaction threshold, retry config).
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';

// Local imports - shared utils
import { createEvent } from '@shared/utils/events';

// Local imports - shared schemas
import type { NumberVscodeSetting } from '@shared/schemas/settingsViewMessages';

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
        padding: var(--spacing-small) var(--spacing-medium);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
        font-family: var(--vscode-editor-font-family);
      }

      .reliability-input:focus {
        outline: none;
        border-color: var(--vscode-focusBorder);
      }

      .reliability-unit {
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      .reliability-description {
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs, 11px);
        margin: 0;
        padding-left: calc(140px + var(--spacing-medium));
      }
    `,
  ];

  @property({ type: Boolean }) superYoloEnabled = false;
  @property({ type: Boolean }) toggleDisabled = true;
  @property({ attribute: false }) reliabilitySettings: NumberVscodeSetting[] =
    [];

  private handleToggle(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.dispatchEvent(
      createEvent('super-yolo-toggle', { enabled: Boolean(target?.checked) }),
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

  private renderReliabilitySetting(
    setting: NumberVscodeSetting,
  ): TemplateResult {
    return html`
      <div class="reliability-row">
        <label>${setting.label}</label>
        <input
          class="reliability-input"
          type="number"
          .value=${String(setting.value)}
          min=${setting.min ?? nothing}
          max=${setting.max ?? nothing}
          @change=${(e: Event) =>
            this.handleReliabilityChange(setting, e.target as HTMLInputElement)}
        />
        ${setting.unit
          ? html`<span class="reliability-unit">${setting.unit}</span>`
          : nothing}
      </div>
      <p class="reliability-description">${setting.description}</p>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="multi-agent-container">
        <h3>Agent Delegation</h3>

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
