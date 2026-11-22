/** Memory management content for the settings view. */

import { html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { postToHost } from '@ui/settings/messageDispatcher';
import { TexraSignalElement } from '@ui/litBase';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';

import { renderStateSettingToggleRow } from '../components/shared/stateSettingRows';
import type { MemoryViewItem } from '@texra-ai/worldline/schemas';
import { MEMORY_ENABLED_SETTING } from '@texra-ai/worldline/schemas';

// Side-effect: register child components.
import '../components/memory/MemoryList';

@customElement('memory-tab')
export class MemoryTab extends TexraSignalElement {
  static override styles = [
    TexraSignalElement.styles,
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
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: var(--wa-space-2xs);
      }
    `,
  ];

  @property({ attribute: false }) items: readonly MemoryViewItem[] = [];

  override render(): TemplateResult {
    return html`
      <div class="memory-view-container tab-content-container">
        <div
          class="memory-actions"
          role="group"
          aria-label="Saved memory actions"
        >
          ${renderLabeledActionButton({
            icon: 'arrows-rotate',
            text: 'Refresh memories',
            kind: 'secondary',
            onClick: () =>
              postToHost({ command: SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA }),
          })}
          ${renderLabeledActionButton({
            icon: 'folder-open',
            text: 'Open memory folder',
            kind: 'secondary',
            onClick: () =>
              postToHost({
                command: SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER,
              }),
          })}
        </div>
        ${renderStateSettingToggleRow(MEMORY_ENABLED_SETTING)}

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
