/** Memory management content for the settings view. */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { MemoryViewItem } from '@shared/schemas';
import {
  commonViewStyles,
  designTokens,
  settingsBannerStyles,
} from '@shared/styles';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderSettingsBanner } from '@shared/wa/settingsBanner';

// Side-effect: register child components.
import '../components/memory/MemoryToggle';
import '../components/memory/MemoryList';

@customElement('memory-tab')
export class MemoryTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    settingsBannerStyles,
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
    return renderSettingsBanner({
      id: 'memory-notes-banner',
      className: 'memory-reminder',
      title: 'Memory notes',
      description:
        'The AI assistant can save notes here to remember important information across conversations. These notes help the assistant provide more contextual and personalized help.',
      actions: html`
        ${renderLabeledActionButton({
          icon: 'rotate-right',
          text: 'Refresh',
          kind: 'secondary',
          appearance: 'outlined',
          onClick: this.handleRefresh,
        })}
        ${renderLabeledActionButton({
          icon: 'folder-open',
          text: 'Open Folder',
          kind: 'secondary',
          appearance: 'outlined',
          title: 'Open memory folder in file explorer',
          onClick: this.handleOpenFolder,
        })}
      `,
    });
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
