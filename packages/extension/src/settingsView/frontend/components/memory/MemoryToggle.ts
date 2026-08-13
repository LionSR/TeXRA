/** Switch to enable/disable memory for chat agents. */

import { LitElement, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { renderSettingsToggleRow } from '@shared/wa/settingsSection';
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
    `,
  ];

  @property({ attribute: false }) enabled = false;
  @property({ attribute: false }) disabled = false;

  private handleChange(event: Event): void {
    const target = event.currentTarget as WaSwitch | null;
    postMessage(SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED, {
      enabled: Boolean(target?.checked),
    });
  }

  override render(): TemplateResult {
    return renderSettingsToggleRow({
      label: 'Enable memory for chat agents',
      description: 'Remember useful details across chat sessions.',
      checked: this.enabled,
      disabled: this.disabled,
      onChange: this.handleChange,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-toggle': MemoryToggle;
  }
}
