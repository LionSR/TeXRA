/** Memory management content for the settings view. */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { designTokens, commonViewStyles } from '@shared/styles';
import type { MemoryViewItem } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Side-effect: register child components.
import '../components/memory/MemoryToggle';
import '../components/memory/MemoryList';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

@customElement('memory-tab')
export class MemoryTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .memory-view-container {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-xs);
      }

      .memory-reminder {
        margin-bottom: 0;
      }
    `,
  ];

  @property({ attribute: false }) items: MemoryViewItem[] = [];
  @property({ attribute: false }) enabled = false;
  @property({ attribute: false }) toggleDisabled = true;

  private handleRefresh = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA);
  };

  private handleOpenFolder = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER);
  };

  private renderMemoryReminder(): TemplateResult {
    return html`
      <div class="settings-reminder memory-reminder">
        ${waIcon('info', { className: 'settings-reminder-icon' })}
        <div class="settings-reminder-body">
          <div class="settings-reminder-title">Memory notes</div>
          <div class="settings-reminder-description">
            The AI assistant can save notes here to remember important
            information across conversations. These notes help the assistant
            provide more contextual and personalized help.
          </div>
          <div class="settings-reminder-actions">
            <wa-button
              appearance="outlined"
              variant="neutral"
              size="small"
              @click=${this.handleRefresh}
            >
              ${waIcon('rotate-right', { slot: 'start' })} Refresh
            </wa-button>
            <wa-button
              appearance="outlined"
              variant="neutral"
              size="small"
              title="Open memory folder in file explorer"
              @click=${this.handleOpenFolder}
            >
              ${waIcon('folder-open', { slot: 'start' })} Open Folder
            </wa-button>
          </div>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="memory-view-container tab-content-container">
        ${this.renderMemoryReminder()}

        <memory-toggle
          .enabled=${this.enabled}
          .disabled=${this.toggleDisabled}
        ></memory-toggle>

        <memory-list .items=${this.items}></memory-list>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-tab': MemoryTab;
  }
}
