/**
 * MultiAgentTab component - multi-agent settings for the settings view.
 * Contains the Super YOLO toggle for auto-approving agent delegation proposals.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';

// Local imports - shared utils
import { createEvent } from '@shared/utils/events';

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
    `,
  ];

  @property({ type: Boolean }) superYoloEnabled = false;
  @property({ type: Boolean }) toggleDisabled = true;

  private handleToggle(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.dispatchEvent(
      createEvent('super-yolo-toggle', { enabled: Boolean(target?.checked) }),
    );
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
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'multi-agent-tab': MultiAgentTab;
  }
}
