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
import { styleMap } from 'lit/directives/style-map.js';
import Sortable from 'sortablejs';

// Local imports - main view
import { MainViewEvents } from '../events';
import {
  fileStateContext,
  type FileStateContextValue,
} from '../contexts/mainViewContexts';

// Local imports - shared types
import type { SortableDragEvent } from '@shared/types/sortable';

@customElement('output-files-section')
export class OutputFilesSection extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    .file-select {
      margin-bottom: var(--spacing-large);
    }

    .file-select-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-small);
      flex-wrap: nowrap;
      line-height: 1.5;
      gap: var(--spacing-small);
    }

    .file-select-label-group {
      display: flex;
      align-items: center;
      gap: var(--spacing-small);
      flex-wrap: nowrap;
      flex: 1;
      min-width: 0;
      min-height: var(--height-control);
    }

    .file-select-actions,
    vscode-toolbar-container.file-select-actions {
      flex-direction: column !important;
      flex-wrap: nowrap;
      margin-left: auto;
    }

    .file-select-actions vscode-toolbar-button,
    .file-action-button {
      width: var(--height-control);
      height: var(--height-control);
      min-width: var(--height-control);
      min-height: var(--height-control);
    }

    .toggle-icon {
      cursor: pointer;
      user-select: none;
      margin: 0;
      position: relative;
      padding: 0 var(--spacing-tiny);
      color: var(--text-color);
      display: flex;
      align-items: center;
      height: var(--height-control);
    }

    .file-select[data-expanded='true'] .toggle-icon {
      color: var(--vscode-foreground);
    }

    .optional-label {
      color: var(--text-color);
      font-weight: normal;
      font-size: var(--font-size);
      white-space: nowrap;
      min-width: calc(var(--width-button-min) * 2);
      display: flex;
      align-items: center;
      height: var(--height-control);
    }

    .multiple-files-container {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-top: var(--spacing-small);
      padding: 0;
    }

    .multiple-files-content {
      width: 100%;
      padding: 0;
    }

    .multiple-files-list {
      background-color: var(--background-color);
      border: 1px solid var(--vscode-widget-border, var(--dropdown-border));
      border-radius: var(--border-radius);
      padding: var(--spacing-small);
      font-size: var(--font-size);
      max-height: var(--height-small);
      overflow-y: auto;
    }

    .file-item {
      padding: var(--spacing-tiny) var(--spacing-small);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .remove-button {
      color: var(--vscode-errorForeground);
      cursor: pointer;
      flex-shrink: 0;
    }

    .file-list-placeholder {
      color: var(--color-text-secondary);
      font-style: italic;
      padding: var(--spacing-tiny) var(--spacing-small);
    }
  `;

  @consume({ context: fileStateContext, subscribe: true })
  private fileState?: FileStateContextValue;

  @query('.multiple-files-list')
  private fileListElement?: HTMLElement;

  private sortable: Sortable | null = null;

  override disconnectedCallback(): void {
    this.destroySortable();
    super.disconnectedCallback();
  }

  protected override updated(changedProps: Map<string, unknown>): void {
    if (changedProps.has('fileState')) {
      this.destroySortable();
    }
    this.initializeSortable();
  }

  private get currentFiles(): string[] {
    return this.fileState?.multiFiles.outputFiles ?? [];
  }

  private get currentExpanded(): boolean {
    return this.fileState?.outputFilesActive ?? false;
  }

  private initializeSortable(): void {
    if (this.sortable || !this.fileListElement) return;
    this.sortable = new Sortable(this.fileListElement, {
      animation: 150,
      onEnd: (event) => this.handleSortEnd(event),
    });
  }

  private destroySortable(): void {
    this.sortable?.destroy();
    this.sortable = null;
  }

  private handleSortEnd(event: unknown): void {
    const { oldIndex, newIndex } = (event ?? {}) as SortableDragEvent;
    if (
      oldIndex === null ||
      oldIndex === undefined ||
      newIndex === null ||
      newIndex === undefined
    ) {
      return;
    }

    const current = [...this.currentFiles];
    const [moved] = current.splice(oldIndex, 1);
    current.splice(newIndex, 0, moved);

    this.dispatchEvent(
      MainViewEvents.filesReordered({ listId: 'outputFiles', files: current }),
    );
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
          <span
            class="remove-button codicon codicon-trash"
            role="button"
            @click=${() => this.handleRemoveFile(file)}
          ></span>
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
            <span
              id="toggleOutputFiles"
              class="toggle-icon"
              title="Show or hide additional files for the agent's output"
              @click=${this.handleToggle}
            >
              <i class="codicon ${chevronClass}"></i>
            </span>
            <span
              class="optional-label"
              title="List the files that should receive the agent's output"
              >Multiple Outputs</span
            >
          </div>
          <vscode-toolbar-container class="file-select-actions">
            <vscode-toolbar-button
              id="emptyOutputFilesButton"
              class="file-action-button"
              icon="trash"
              label="Clear all output files"
              title="Clear all output files"
              @click=${this.handleEmptyFiles}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="selectOutputFilesButton"
              class="file-action-button"
              icon="add"
              label="Add output files"
              title="Add output files"
              @click=${this.handleSelectFiles}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>
        <div
          id="outputFilesContainer"
          class="multiple-files-container"
          style=${styleMap({
            display: this.currentExpanded ? 'block' : 'none',
          })}
        >
          <div class="multiple-files-content">
            <div id="outputFiles" class="multiple-files-list">
              ${this.renderFileList()}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'output-files-section': OutputFilesSection;
  }
}
