/** Collapsible output files list with toggle and action buttons. */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, query } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - main view
import { SortableController } from '@shared/controllers';
import { designTokens } from '@shared/styles';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { MainViewEvents } from '../events';
import {
  fileStateContext,
  type FileStateContextValue,
} from '../contexts/mainViewContexts';
import {
  compactActionButtonStyles,
  fileSelectLayoutStyles,
  toggleStyles,
  multiFilesStyles,
} from '../styles/fileSelectStyles';

@customElement('output-files-section')
export class OutputFilesSection extends LitElement {
  static override styles = [
    designTokens,
    compactActionButtonStyles,
    fileSelectLayoutStyles,
    toggleStyles,
    multiFilesStyles,
    css`
      :host {
        display: block;
      }

      .multiple-files-list {
        padding: var(--wa-space-3xs);
      }

      .file-item {
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        border-radius: var(--border-radius-small);
      }

      .file-item .file-name {
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
      }

      .file-item .remove-button {
        opacity: 0;
      }

      .file-item:hover .remove-button,
      .file-item:focus-within .remove-button {
        opacity: 1;
      }

      .file-list-placeholder {
        font-size: var(--font-size-sm);
        line-height: var(--line-height-normal);
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
      }
    `,
  ];

  @consume({ context: fileStateContext, subscribe: true })
  private fileState?: FileStateContextValue;

  @query('.multiple-files-list')
  private fileListElement?: HTMLElement;

  private sortableController = new SortableController(
    this,
    () => this.fileListElement,
    () => this.currentFiles,
    (result) =>
      this.dispatchEvent(
        MainViewEvents.filesReordered({
          listId: 'outputFiles',
          files: result.items,
        }),
      ),
  );

  private get currentFiles(): string[] {
    return this.fileState?.multiFiles.outputFiles ?? [];
  }

  private get currentExpanded(): boolean {
    return this.fileState?.outputFilesActive ?? false;
  }

  /** Track previous expanded state to detect visibility changes */
  private wasExpanded = false;

  protected override updated(): void {
    // Reinitialize Sortable when list becomes visible (element is recreated)
    if (this.currentExpanded && !this.wasExpanded) {
      this.sortableController.reinitialize();
    }
    this.wasExpanded = this.currentExpanded;
  }

  private handleToggle(): void {
    this.dispatchEvent(MainViewEvents.toggleList({ listId: 'outputFiles' }));
  }

  private handleEmptyFiles(): void {
    this.dispatchEvent(MainViewEvents.emptyFiles({ type: 'output' }));
  }

  private handleSelectFiles(): void {
    this.dispatchEvent(
      MainViewEvents.selectMultipleFiles({ listId: 'outputFiles' }),
    );
  }

  private handleRemoveClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-remove-file]',
    );
    if (!button) return;
    const file = button.dataset.removeFile;
    if (file) {
      this.dispatchEvent(
        MainViewEvents.removeFile({ listId: 'outputFiles', file }),
      );
    }
  }

  private renderFileList(): TemplateResult {
    if (this.currentFiles.length === 0) {
      return html`<div class="file-list-placeholder">
        No extra outputs selected. Click "Add" to choose files.
      </div>`;
    }

    return html`<div @click=${this.handleRemoveClick}>
      ${repeat(
        this.currentFiles,
        (file) => file,
        (file) => html`
          <div class="file-item" data-path=${file}>
            <span class="file-name">${file}</span>
            <wa-button
              class="action-icon-button remove-button"
              appearance="plain"
              variant="neutral"
              size="small"
              type="button"
              aria-label="Remove output file"
              data-remove-file=${file}
            >
              ${waIcon('trash')}
            </wa-button>
          </div>
        `,
      )}
    </div>`;
  }

  override render(): TemplateResult {
    const chevronName = this.currentExpanded ? 'chevron-up' : 'chevron-down';

    return html`
      <div class="file-select" data-expanded=${String(this.currentExpanded)}>
        <div class="file-select-header">
          <div class="file-select-label-group">
            <button
              id="toggleOutputFiles"
              class="toggle-icon"
              title="Show or hide additional files for the agent's output"
              type="button"
              aria-label="Show or hide additional files for the agent's output"
              @click=${this.handleToggle}
            >
              ${waIcon(chevronName)}
            </button>
            <span
              class="optional-label"
              title="List the files that should receive the agent's output"
              >Multiple Outputs</span
            >
            <span
              class="file-select-hint"
              title="Agent writes to all listed files"
              >Agent writes to all listed files</span
            >
          </div>
          <div class="file-select-actions">
            ${renderIconActionButton({
              id: 'emptyOutputFilesButton',
              icon: 'trash',
              label: 'Clear all output files',
              title: 'Clear all output files',
              onClick: this.handleEmptyFiles,
            })}
            ${renderIconActionButton({
              id: 'selectOutputFilesButton',
              icon: 'add',
              label: 'Add output files',
              title: 'Add output files',
              onClick: this.handleSelectFiles,
            })}
          </div>
        </div>
        ${when(
          this.currentExpanded,
          () => html`
            <div id="outputFilesContainer" class="multiple-files-container">
              <div class="multiple-files-content">
                <div id="outputFiles" class="multiple-files-list">
                  ${this.renderFileList()}
                </div>
              </div>
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'output-files-section': OutputFilesSection;
  }
}
