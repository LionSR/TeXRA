/**
 * OutputFilesSection component for MainView multiple outputs.
 *
 * Renders the collapsible output files list with toggle and action buttons.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, query } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - main view
import { SortableController } from '@shared/controllers';
import { codiconStyles } from '@shared/styles';
import { MainViewEvents } from '../events';
import {
  fileStateContext,
  type FileStateContextValue,
} from '../contexts/mainViewContexts';
import {
  fileSelectLayoutStyles,
  toggleStyles,
  multiFilesStyles,
} from '../styles/fileSelectStyles';

@customElement('output-files-section')
export class OutputFilesSection extends LitElement {
  static override styles = [
    codiconStyles,
    fileSelectLayoutStyles,
    toggleStyles,
    multiFilesStyles,
    css`
      :host {
        display: block;
      }

      .file-select-actions vscode-toolbar-button {
        width: var(--height-control);
        height: var(--height-control);
        min-width: var(--height-control);
        min-height: var(--height-control);
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

  private handleRemoveFile(file: string): void {
    this.dispatchEvent(
      MainViewEvents.removeFile({ listId: 'outputFiles', file }),
    );
  }

  private renderFileList(): TemplateResult {
    if (this.currentFiles.length === 0) {
      return html`<div class="file-list-placeholder">
        No extra outputs selected. Click "Add" to choose files.
      </div>`;
    }

    return html`${repeat(
      this.currentFiles,
      (file) => file,
      (file) => html`
        <div class="file-item" data-path=${file}>
          <span class="file-name">${file}</span>
          <button
            type="button"
            class="remove-button codicon codicon-trash"
            aria-label=${`Remove ${file}`}
            @click=${() => this.handleRemoveFile(file)}
          ></button>
        </div>
      `,
    )}`;
  }

  override render(): TemplateResult {
    const chevronClass = this.currentExpanded
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';

    return html`
      <div class="file-select" data-expanded=${String(this.currentExpanded)}>
        <div class="file-select-header">
          <div class="file-select-label-group">
            <button
              id="toggleOutputFiles"
              type="button"
              class="toggle-icon"
              title="Show or hide additional files for the agent's output"
              aria-label="Show or hide additional files for the agent's output"
              @click=${this.handleToggle}
            >
              <i class="codicon ${chevronClass}"></i>
            </button>
            <span
              class="optional-label"
              title="List the files that should receive the agent's output"
              >Multiple Outputs</span
            >
          </div>
          <vscode-toolbar-container class="file-select-actions">
            <vscode-toolbar-button
              id="emptyOutputFilesButton"
              icon="trash"
              label="Clear all output files"
              title="Clear all output files"
              @click=${this.handleEmptyFiles}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="selectOutputFilesButton"
              icon="add"
              label="Add output files"
              title="Add output files"
              @click=${this.handleSelectFiles}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
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
