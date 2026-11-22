/** The Memory page of the settings view: the switch, and the two folders. */

import { html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import type { MemoryFolderScope } from '@texra/shared/settingsView/memoryViewMessages';
import { postToHost } from '@ui/settings/messageDispatcher';
import { TexraSignalElement } from '@ui/litBase';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';

import { renderStateSettingToggleRow } from '../components/shared/stateSettingRows';
import { MEMORY_ENABLED_SETTING } from '@texra-ai/harness/schemas';

/** A button that opens one memory folder in the system's file manager. */
const openFolderButton = (folder: MemoryFolderScope, text: string) =>
  renderLabeledActionButton({
    icon: 'folder-open',
    text,
    kind: 'secondary',
    onClick: () =>
      postToHost({
        command: SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER,
        folder,
      }),
  });

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
        gap: var(--wa-space-2xs);
      }

      .memory-note {
        margin: 0;
        color: var(--wa-color-text-quiet);
      }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <div class="memory-view-container tab-content-container">
        ${renderStateSettingToggleRow(MEMORY_ENABLED_SETTING)}
        <p class="memory-note">
          Agents keep Markdown notes in two folders: one for you, in every
          project, and one for this project. Each folder's MEMORY.md is the
          index an agent sees at the start of every request. Open a folder to
          read, edit or delete notes.
        </p>
        <div class="memory-actions" role="group" aria-label="Memory folders">
          ${openFolderButton('user', 'Open your memory folder')}
          ${openFolderButton('project', "Open this project's memory folder")}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-tab': MemoryTab;
  }
}
