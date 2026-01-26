// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - main view
import { mainViewStyles } from '@webview/frontend/styles';

export type OutputFilesAction =
  | 'toggle'
  | 'empty-list'
  | 'select-list'
  | 'remove';

export interface OutputFilesActionDetail {
  action: OutputFilesAction;
  listId: string;
  filePath?: string;
}

@customElement('output-files-group')
export class OutputFilesGroup extends LitElement {
  static styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    mainViewStyles,
  ];

  @property({ type: Array }) files: string[] = [];
  @property({ type: Boolean }) isActive = false;

  private emitAction(detail: OutputFilesActionDetail): void {
    this.dispatchEvent(
      new CustomEvent<OutputFilesActionDetail>('output-files-action', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleActionClick = (event: Event): void => {
    const target = event.currentTarget as HTMLElement | null;
    const action = target?.dataset.action as OutputFilesAction | undefined;
    if (!action) return;
    this.emitAction({ action, listId: 'outputFiles' });
  };

  private handleRemoveClick = (event: Event): void => {
    const target = event.currentTarget as HTMLElement | null;
    const filePath = target?.dataset.filePath;
    if (!filePath) return;
    this.emitAction({ action: 'remove', listId: 'outputFiles', filePath });
  };

  render(): TemplateResult {
    const chevronClass = this.isActive
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';
    return html`
      <div class="file-select" data-expanded=${String(this.isActive)}>
        <div class="file-select-header">
          <div class="file-select-label-group">
            <span
              id="toggleOutputFiles"
              class="toggle-icon"
              title="Show or hide additional files for the agent's output"
              data-action="toggle"
              @click=${this.handleActionClick}
            >
              <i class="codicon ${chevronClass}"></i>
            </span>
            <span
              class="optional-label"
              title="List the files that should receive the agent’s output"
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
              data-action="empty-list"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="selectOutputFilesButton"
              class="file-action-button"
              icon="add"
              label="Add output files"
              title="Add output files"
              data-action="select-list"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>
        <div
          id="outputFilesContainer"
          class="multiple-files-container"
          style=${this.isActive ? 'display: block' : 'display: none'}
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

  private renderFileList(): TemplateResult {
    if (this.files.length === 0) {
      return html`<div class="file-list-placeholder">
        No extra outputs selected. Click "Add" to choose files.
      </div>`;
    }

    return html`${repeat(
      this.files,
      (file) => file,
      (file) => html`
        <div class="file-item" data-path=${file}>
          <span class="file-name">${file}</span>
          <span
            class="remove-button codicon codicon-trash"
            role="button"
            data-file-path=${file}
            @click=${this.handleRemoveClick}
          ></span>
        </div>
      `,
    )}`;
  }
}
