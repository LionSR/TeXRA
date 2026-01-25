// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens } from '@shared/styles/litStyles';

// Local imports - memory view events
import { MemoryViewEvents } from '../events';

@customElement('memory-toggle')
export class MemoryToggle extends LitElement {
  static styles = [
    designTokens,
    css`
      :host {
        display: block;
      }

      .memory-settings {
        padding: var(--spacing-medium);
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: var(--border-radius);
        margin-bottom: var(--spacing-small);
      }
    `,
  ];

  @property({ type: Boolean }) enabled = false;
  @property({ type: Boolean }) disabled = false;

  @query('vscode-checkbox')
  declare private checkboxEl: HTMLElement & { checked?: boolean };

  protected updated(): void {
    if (!this.checkboxEl) return;
    void customElements.whenDefined('vscode-checkbox').then(() => {
      this.checkboxEl.checked = this.enabled;
    });
  }

  private handleChange = (event: Event): void => {
    const target = event.target as HTMLInputElement | null;
    this.dispatchEvent(
      MemoryViewEvents.toggleEnabled(Boolean(target?.checked)),
    );
  };

  render(): TemplateResult {
    return html`
      <div class="memory-settings">
        <vscode-checkbox
          ?disabled=${this.disabled}
          @change=${this.handleChange}
        >
          Enable memory for chat agents
        </vscode-checkbox>
      </div>
    `;
  }
}
