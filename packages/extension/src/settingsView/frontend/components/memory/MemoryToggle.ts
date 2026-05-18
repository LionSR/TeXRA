/** Switch to enable/disable memory for chat agents. */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - memory view events
import { MemoryViewEvents } from './events';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

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
    const target = event.currentTarget as WaSwitch | null;
    this.dispatchEvent(
      MemoryViewEvents.toggleEnabled({ enabled: Boolean(target?.checked) }),
    );
  }

  override render(): TemplateResult {
    return html`
      <div class="memory-settings">
        <wa-switch
          ?checked=${this.enabled}
          ?disabled=${this.disabled}
          @change=${this.handleChange}
        >
          Enable memory for chat agents
        </wa-switch>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-toggle': MemoryToggle;
  }
}
