/**
 * MemoryToggle component - checkbox to enable/disable memory for chat agents.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens } from '@shared/styles';

// Local imports - memory view events
import { MemoryViewEvents } from './events';

@customElement('memory-toggle')
export class MemoryToggle extends LitElement {
  static override styles = [
    designTokens,
    css`
      :host {
        display: block;
      }

      .memory-settings {
        padding: var(--spacing-medium);
        background-color: var(--texra-editor-inactiveSelectionBackground);
        border-radius: var(--border-radius);
        margin-bottom: var(--spacing-small);
      }
    `,
  ];

  @property({ attribute: false }) enabled = false;
  @property({ attribute: false }) disabled = false;

  private handleChange(event: Event): void {
    const target = event.currentTarget as HTMLInputElement | null;
    this.dispatchEvent(
      MemoryViewEvents.toggleEnabled({ enabled: Boolean(target?.checked) }),
    );
  }

  override render(): TemplateResult {
    return html`
      <div class="memory-settings">
        <vscode-checkbox
          ?checked=${this.enabled}
          ?disabled=${this.disabled}
          @change=${this.handleChange}
        >
          Enable memory for chat agents
        </vscode-checkbox>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-toggle': MemoryToggle;
  }
}
