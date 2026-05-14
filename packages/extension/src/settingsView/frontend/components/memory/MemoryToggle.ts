/** Checkbox to enable/disable memory for chat agents. */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - memory view events
import { MemoryViewEvents } from './events';
import type WaCheckbox from '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';

@customElement('memory-toggle')
export class MemoryToggle extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .memory-settings {
        display: flex;
        align-items: center;
        min-height: 22px;
      }
    `,
  ];

  @property({ attribute: false }) enabled = false;
  @property({ attribute: false }) disabled = false;

  private handleChange(event: Event): void {
    const target = event.currentTarget as WaCheckbox | null;
    this.dispatchEvent(
      MemoryViewEvents.toggleEnabled({ enabled: Boolean(target?.checked) }),
    );
  }

  override render(): TemplateResult {
    return html`
      <div class="memory-settings">
        <wa-checkbox
          ?checked=${this.enabled}
          ?disabled=${this.disabled}
          @change=${this.handleChange}
        >
          Enable memory for chat agents
        </wa-checkbox>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-toggle': MemoryToggle;
  }
}
