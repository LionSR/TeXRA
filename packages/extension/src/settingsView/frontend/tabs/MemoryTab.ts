/** Memory management content for the settings view. */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import type { MemoryViewItem } from '@shared/schemas';

import { MemoryViewEvents } from '../components/memory/events';

// Side-effect: register child components.
import '../components/memory/MemoryToggle';
import '../components/memory/MemoryList';
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
    this.dispatchEvent(MemoryViewEvents.refresh());
  };

  private handleOpenFolder = (): void => {
    this.dispatchEvent(MemoryViewEvents.openFolder());
  };

  private renderMemoryReminder(): TemplateResult {
    return html`
      <div class="settings-reminder memory-reminder">
        <wa-icon
          library="texra"
          name="info"
          class="settings-reminder-icon"
        ></wa-icon>
        <div class="settings-reminder-body">
          <div class="settings-reminder-title">Memory notes</div>
          <div class="settings-reminder-description">
            The AI assistant can save notes here to remember important
            information across conversations. These notes help the assistant
            provide more contextual and personalized help.
          </div>
          <div class="settings-reminder-actions">
            <button class="tab-action-btn" @click=${this.handleRefresh}>
              <wa-icon library="texra" name="rotate-right"></wa-icon>
              Refresh
            </button>
            <button
              class="tab-action-btn"
              @click=${this.handleOpenFolder}
              title="Open memory folder in file explorer"
            >
              <wa-icon library="texra" name="folder-open"></wa-icon>
              Open Folder
            </button>
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
