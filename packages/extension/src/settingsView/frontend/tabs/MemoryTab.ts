/** Memory management content for the settings view. */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { MemoryViewItem } from '@shared/schemas';
import { commonViewStyles, designTokens } from '@shared/styles';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

import { renderStateSettingToggleRow } from '../components/shared/stateSettingRows';

// Side-effect: register child components.
import '../components/memory/MemoryList';

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

      .memory-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--wa-space-2xs);
      }
    `,
  ];

  @property({ attribute: false }) items: MemoryViewItem[] = [];
  @property({ attribute: false }) enabled = false;

  private handleRefresh = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA);
  };

  private handleOpenFolder = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER);
  };

  private renderActions(): TemplateResult {
    return html`<div class="memory-actions">
      ${renderLabeledActionButton({
        icon: 'rotate-right',
        text: 'Refresh',
        kind: 'secondary',
        appearance: 'outlined',
        onClick: this.handleRefresh,
      })}
      ${renderLabeledActionButton({
        icon: 'folder-open',
        text: 'Open folder',
        kind: 'secondary',
        appearance: 'outlined',
        title: 'Open memory folder in file explorer',
        onClick: this.handleOpenFolder,
      })}
    </div>`;
  }

  override render(): TemplateResult {
    return html`
      <div class="memory-view-container tab-content-container">
        ${this.renderActions()}
        ${renderStateSettingToggleRow({
          key: GlobalStateKey.MEMORY_ENABLED,
          label: 'Enable memory for chat agents',
          description: 'Remember useful details across chat sessions.',
          checked: this.enabled,
        })}

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
