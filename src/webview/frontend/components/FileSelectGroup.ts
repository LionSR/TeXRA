// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - main view
import { mainViewStyles } from '@webview/frontend/styles';
import type { FileType } from '@webview/frontend/constants';

export type FileSelectAction =
  | 'refresh'
  | 'current'
  | 'empty'
  | 'toggle'
  | 'add-opened'
  | 'empty-list'
  | 'select-list'
  | 'remove'
  | 'change';

export interface FileSelectActionDetail {
  action: FileSelectAction;
  fileType: FileType;
  listId: string;
  value?: string;
  filePath?: string;
}

export interface FileSelectFocusDetail {
  key: string;
  text: string;
}

export interface FileSelectConfig {
  type: FileType;
  label: string;
  icon: string;
  refreshTitle: string;
  currentTitle: string;
  emptyTitle: string;
  toggleTitle: string;
  addOpenedLabel: string;
  emptyListLabel: string;
  selectListLabel: string;
  tooltip: string;
  focusInstruction?: { key: string; text: string };
}

@customElement('file-select-group')
export class FileSelectGroup extends LitElement {
  static styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    mainViewStyles,
  ];

  @property({ type: Object }) config!: FileSelectConfig;
  @property({ type: String }) selectedValue = '';
  @property({ type: String }) optionsHtml = '';
  @property({ type: Boolean }) isVisible = false;
  @property({ type: Array }) files: string[] = [];
  @property({ attribute: false }) toolConfigMenu: TemplateResult | null = null;

  private get listId(): string {
    return `${this.config.type}Files`;
  }

  private get selectId(): string {
    return `${this.config.type}File`;
  }

  private get toggleId(): string {
    const { type } = this.config;
    return `toggle${type[0].toUpperCase()}${type.slice(1)}Files`;
  }

  private emitAction(detail: FileSelectActionDetail): void {
    this.dispatchEvent(
      new CustomEvent<FileSelectActionDetail>('file-select-action', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitFocus = (): void => {
    if (!this.config.focusInstruction) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<FileSelectFocusDetail>('file-select-focus', {
        detail: this.config.focusInstruction,
        bubbles: true,
        composed: true,
      }),
    );
  };

  private handleActionClick = (event: Event): void => {
    const target = event.currentTarget as HTMLElement | null;
    const action = target?.dataset.action as FileSelectAction | undefined;
    if (!action) return;
    this.emitAction({
      action,
      fileType: this.config.type,
      listId: this.listId,
    });
  };

  private handleRemoveClick = (event: Event): void => {
    const target = event.currentTarget as HTMLElement | null;
    const filePath = target?.dataset.filePath;
    if (!filePath) return;
    this.emitAction({
      action: 'remove',
      fileType: this.config.type,
      listId: this.listId,
      filePath,
    });
  };

  private handleSelectChange = (event: Event): void => {
    const target = event.currentTarget as HTMLInputElement | null;
    if (!target) return;
    this.emitAction({
      action: 'change',
      fileType: this.config.type,
      listId: this.listId,
      value: target.value,
    });
  };

  render(): TemplateResult {
    const chevronClass = this.isVisible
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';

    return html`
      <div class="file-select" data-expanded=${String(this.isVisible)}>
        <div class="file-select-header">
          <div class="file-select-label-group">
            <vscode-toolbar-button
              id="refresh${this.config.type[0].toUpperCase()}${this.config.type.slice(
                1,
              )}FileButton"
              icon=${this.config.icon}
              label=${this.config.refreshTitle}
              title=${this.config.refreshTitle}
              data-action="refresh"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <label for=${this.selectId} title=${this.config.tooltip}
              >${this.config.label}</label
            >
            ${this.toolConfigMenu}
          </div>
          <vscode-toolbar-container class="file-select-actions">
            <vscode-toolbar-button
              id="current${this.config.type[0].toUpperCase()}${this.config.type.slice(
                1,
              )}FileButton"
              icon="file-code"
              label=${this.config.currentTitle}
              title=${this.config.currentTitle}
              data-action="current"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="empty${this.config.type[0].toUpperCase()}${this.config.type.slice(
                1,
              )}FileButton"
              icon="close"
              label=${this.config.emptyTitle}
              title=${this.config.emptyTitle}
              data-action="empty"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <span
              id=${this.toggleId}
              class="toggle-icon"
              title=${this.config.toggleTitle}
              data-action="toggle"
              @click=${this.handleActionClick}
            >
              <i class="codicon ${chevronClass}"></i>
            </span>
            <vscode-toolbar-button
              id="addOpened${this.config.type[0].toUpperCase()}${this.config.type.slice(
                1,
              )}FilesButton"
              class="file-action-button"
              icon="folder-opened"
              label=${this.config.addOpenedLabel}
              title=${this.config.addOpenedLabel}
              data-action="add-opened"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="empty${this.config.type[0].toUpperCase()}${this.config.type.slice(
                1,
              )}FilesButton"
              class="file-action-button"
              icon="trash"
              label=${this.config.emptyListLabel}
              title=${this.config.emptyListLabel}
              data-action="empty-list"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="select${this.config.type[0].toUpperCase()}${this.config.type.slice(
                1,
              )}FilesButton"
              class="file-action-button"
              icon="add"
              label=${this.config.selectListLabel}
              title=${this.config.selectListLabel}
              data-action="select-list"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>
        <vscode-single-select
          id=${this.selectId}
          .value=${this.selectedValue}
          @focus=${this.emitFocus}
          @change=${this.handleSelectChange}
        >
          ${unsafeHTML(this.optionsHtml)}
        </vscode-single-select>
        <div
          id="${this.listId}Container"
          class="multiple-files-container"
          style=${this.isVisible ? 'display: block' : 'display: none'}
        >
          <div class="multiple-files-content">
            <div id=${this.listId} class="multiple-files-list">
              ${this.renderFileList()}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderFileList(): TemplateResult {
    if (this.files.length === 0) {
      return html`<div class="file-list-placeholder">No files selected.</div>`;
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
