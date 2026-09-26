/**
 * The new-task composer's attachments: the one home for attaching files to
 * an interactive task. It wraps the composer, so a file dropped on the
 * composer attaches, and it lists what is attached under it as removable
 * chips. The composer's paperclip fills the same list. A document pass keeps
 * its Input/Context groups in the launcher's file section instead.
 */

import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

import { SessionUiEvents } from '@shared/session/uiEvents';
import { designTokens } from '@ui/styles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

import { FileDropController, postDroppedFiles } from '../fileDropHandler';

@customElement('launch-attachments')
export class LaunchAttachments extends LitElement {
  static override styles = [
    designTokens,
    css`
      :host {
        display: block;
      }
      .drop {
        border-radius: var(--wa-border-radius-l);
      }
      .drop.is-drag-active {
        outline: 2px dashed var(--wa-color-focus);
        outline-offset: -2px;
      }
      .files {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-3xs);
        /* Flush with the composer card's own inline padding. */
        padding: 0 var(--wa-space-xs) var(--wa-space-xs);
      }
      .file {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        max-width: 100%;
        padding: 0 0 0 var(--wa-space-2xs);
        border: var(--border-thin) solid var(--wa-color-surface-border);
        border-radius: var(--wa-border-radius-pill);
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet);
      }
      .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  /** The launcher's media list; empty for a document pass. */
  @property({ attribute: false }) files: readonly string[] = [];

  private readonly fileDrop = new FileDropController(this, (paths) =>
    postDroppedFiles(this, paths, 'media'),
  );

  private detach(file: string): void {
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'launch',
        patch: { mediaFiles: this.files.filter((entry) => entry !== file) },
      }),
    );
  }

  override render(): TemplateResult {
    // Drag events from the slotted composer bubble through the slot, so the
    // whole composer is the drop target.
    return html`<div
      class=${classMap({ drop: true, 'is-drag-active': this.fileDrop.isDragActive })}
      @dragenter=${this.fileDrop.handleDragEnter}
      @dragover=${this.fileDrop.handleDragOver}
      @dragleave=${this.fileDrop.handleDragLeave}
      @drop=${this.fileDrop.handleDrop}
    >
      <slot></slot>${
        this.files.length === 0
          ? nothing
          : html`<div class="files" role="list" aria-label="Attached files">
              ${repeat(
                this.files,
                (file) => file,
                (file, index) =>
                  html`<span class="file" role="listitem" title=${file}
                    >${waIcon('file')}<span class="name"
                      >${getBasename(file)}</span
                    >${renderIconActionButton({
                      id: `launch-attachment-remove-${index}`,
                      icon: 'xmark',
                      label: `Remove ${getBasename(file)}`,
                      className: 'icon-button is-size-s',
                      onClick: () => this.detach(file),
                    })}</span
                  >`,
              )}
            </div>`
      }
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'launch-attachments': LaunchAttachments;
  }
}
