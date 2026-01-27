/**
 * FileSelectGroup component for MainView file selection.
 *
 * Renders a file selection dropdown with optional multiple files list,
 * and optional tool config / auto-extract menus.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, property, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { when } from 'lit/directives/when.js';
import Sortable from 'sortablejs';

// Note: Previous dropdown.ts utils no longer needed - using Lit templates directly

// Local imports - main view
import { MainViewEvents } from '../events';
import { SESSION_TYPES } from '../constants';
import {
  fileStateContext,
  type FileStateContextValue,
} from '../contexts/mainViewContexts';

// Local imports - shared schemas
import type { CheckboxValues, FileSelectConfig } from '@shared/schemas';

// Local imports - shared types
import type { SortableDragEvent } from '@shared/types/sortable';

const DEFAULT_CHECKBOX_VALUES: CheckboxValues = {
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  autoCompileInputPdf: false,
  attachTeXCount: false,
  attachDiagnostics: false,
};

@customElement('file-select-group')
export class FileSelectGroup extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    .file-select {
      margin-bottom: var(--spacing-large);
    }

    .file-select:has(.optional-label) {
      margin-bottom: var(--spacing-tiny);
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

    .file-select-label-group vscode-toolbar-button {
      opacity: 1;
    }

    .file-select-header > vscode-toolbar-button {
      opacity: 1;
      flex-shrink: 0;
    }

    .file-select-label-group label {
      margin-right: var(--spacing-small);
    }

    .file-select-label-group vscode-textfield {
      flex: 1;
      min-width: 0;
      margin: 0;
    }

    .file-select-actions,
    vscode-toolbar-container.file-select-actions {
      flex-direction: column !important;
      flex-wrap: nowrap;
      margin-left: auto;
    }

    .file-select-actions vscode-toolbar-button {
      opacity: 1;
      width: var(--height-control);
      height: var(--height-control);
      min-width: var(--height-control);
      min-height: var(--height-control);
    }

    .file-select vscode-single-select {
      width: 100%;
    }

    .file-select:not([data-expanded='true']) .file-action-button {
      display: none;
    }

    .file-select[data-expanded='true'] .optional-label {
      color: var(--vscode-foreground);
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

    /* Dropdown menu styles */
    .dropdown-container {
      position: relative;
      display: inline-flex;
      align-items: center;
    }

    .dropdown-container vscode-toolbar-button {
      flex-shrink: 0;
    }

    .dropdown-container .dropdown-menu {
      position: absolute;
      top: calc(100% + var(--spacing-tiny));
      left: 0;
      right: auto;
      z-index: 100;
      display: block;
      background-color: var(--vscode-menu-background);
      color: var(--vscode-menu-foreground);
      border: 1px solid var(--vscode-menu-border);
      border-radius: var(--border-radius);
      min-width: 160px;
    }

    .dropdown-container .dropdown-menu:not([show]) {
      display: none;
    }

    .dropdown-container .dropdown-menu .dropdown-menu-content {
      display: flex;
      flex-direction: column;
      gap: 0;
      padding: var(--spacing-tiny);
    }

    .dropdown-container .dropdown-menu vscode-checkbox {
      display: flex;
      align-items: center;
      height: 20px;
      padding: var(--spacing-tiny);
      font-size: var(--font-size-sm);
    }

    .dropdown-container .dropdown-menu vscode-checkbox:hover {
      background: var(--vscode-list-hoverBackground);
    }
  `;

  /** File type configuration */
  @property({ type: Object }) config!: FileSelectConfig;

  @consume({ context: fileStateContext, subscribe: true })
  private fileState?: FileStateContextValue;

  /** Auto-extract menu open state */
  @state() private autoExtractMenuOpen = false;

  /** Tool config menu open state */
  @state() private toolConfigMenuOpen = false;

  @query('.multiple-files-list')
  private fileListElement?: HTMLElement;

  private sortable: Sortable | null = null;

  override disconnectedCallback(): void {
    this.destroySortable();
    super.disconnectedCallback();
  }

  protected override updated(changedProps: Map<string, unknown>): void {
    if (changedProps.has('config')) {
      this.destroySortable();
    }
    this.initializeSortable();
  }

  private get listId(): string {
    return `${this.config.type}Files`;
  }

  private get selectId(): string {
    return `${this.config.type}File`;
  }

  private toggleMenu(type: 'autoExtract' | 'toolConfig'): void {
    if (type === 'autoExtract') {
      this.autoExtractMenuOpen = !this.autoExtractMenuOpen;
      if (this.autoExtractMenuOpen) {
        this.toolConfigMenuOpen = false;
      }
    } else {
      this.toolConfigMenuOpen = !this.toolConfigMenuOpen;
      if (this.toolConfigMenuOpen) {
        this.autoExtractMenuOpen = false;
      }
    }
  }

  private handleFileChange(value: string): void {
    this.dispatchEvent(
      MainViewEvents.fileChange({ type: this.config.type, value }),
    );
  }

  private handleRefreshFiles(): void {
    this.dispatchEvent(MainViewEvents.refreshFiles({ type: this.config.type }));
  }

  private handleGetCurrentFile(): void {
    this.dispatchEvent(
      MainViewEvents.getCurrentFile({ type: this.config.type }),
    );
  }

  private handleEmptyFile(): void {
    this.dispatchEvent(MainViewEvents.emptyFile({ type: this.config.type }));
  }

  private handleToggleList(): void {
    this.dispatchEvent(MainViewEvents.toggleList({ listId: this.listId }));
  }

  private handleAddOpenedFiles(): void {
    this.dispatchEvent(
      MainViewEvents.addOpenedFiles({ type: this.config.type }),
    );
  }

  private handleEmptyFiles(): void {
    this.dispatchEvent(MainViewEvents.emptyFiles({ type: this.config.type }));
  }

  private handleSelectMultipleFiles(): void {
    this.dispatchEvent(
      MainViewEvents.selectMultipleFiles({ listId: this.listId }),
    );
  }

  private handleRemoveFile(file: string): void {
    this.dispatchEvent(
      MainViewEvents.removeFile({ listId: this.listId, file }),
    );
  }

  private handleCheckboxChange(id: string, checked: boolean): void {
    this.dispatchEvent(MainViewEvents.checkboxChange({ id, checked }));
  }

  private handleFocus(): void {
    if (this.config.focusInstruction) {
      this.dispatchEvent(
        MainViewEvents.focusInstruction({
          key: this.config.focusInstruction.key,
          text: this.config.focusInstruction.text,
        }),
      );
    }
  }

  private get currentCheckboxValues(): CheckboxValues {
    return this.fileState?.checkboxValues ?? DEFAULT_CHECKBOX_VALUES;
  }

  private get currentSelectedValue(): string {
    const key =
      `${this.config.type}File` as keyof FileStateContextValue['singleFiles'];
    return this.fileState?.singleFiles[key] ?? '';
  }

  private get currentOptions(): string[] {
    const key =
      `${this.config.type}File` as keyof FileStateContextValue['fileOptions'];
    return this.fileState?.fileOptions[key] ?? [];
  }

  private get currentFiles(): string[] {
    const key =
      `${this.config.type}Files` as keyof FileStateContextValue['multiFiles'];
    return this.fileState?.multiFiles[key] ?? [];
  }

  private get currentListVisible(): boolean {
    const key =
      `${this.config.type}Files` as keyof FileStateContextValue['multiFilesVisible'];
    return this.fileState?.multiFilesVisible[key] ?? false;
  }

  private get isToolUseSession(): boolean {
    return this.fileState?.sessionType === SESSION_TYPES.TOOL_USE;
  }

  private handleFocusOut(event: FocusEvent): void {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !this.contains(nextTarget)) {
      this.autoExtractMenuOpen = false;
      this.toolConfigMenuOpen = false;
    }
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
      MainViewEvents.filesReordered({ listId: this.listId, files: current }),
    );
  }

  private renderFileOptions(): TemplateResult {
    const sortedOptions = [...this.currentOptions].sort((a, b) =>
      a.localeCompare(b),
    );
    return html`
      <vscode-option value="" ?selected=${this.currentSelectedValue === ''}
        >None</vscode-option
      >
      ${repeat(
        sortedOptions,
        (opt) => opt,
        (opt) => html`
          <vscode-option
            value=${opt}
            ?selected=${opt === this.currentSelectedValue}
          >
            ${opt}
          </vscode-option>
        `,
      )}
    `;
  }

  private renderToolConfigMenu(): TemplateResult {
    const hasChecked =
      this.currentCheckboxValues.attachTeXCount ||
      this.currentCheckboxValues.attachDiagnostics;
    const chevronClass = this.toolConfigMenuOpen
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';

    return html`
      <div class="dropdown-container">
        <vscode-toolbar-button
          id="toggleToolConfig"
          icon="tools"
          title="Tool configuration options"
          toggleable
          aria-haspopup="true"
          aria-expanded=${this.toolConfigMenuOpen ? 'true' : 'false'}
          ?checked=${hasChecked}
          @click=${() => this.toggleMenu('toolConfig')}
        >
          <i class="codicon ${chevronClass}"></i>
        </vscode-toolbar-button>
        <vscode-context-menu
          id="toolConfigOptions"
          class="dropdown-menu"
          ?show=${this.toolConfigMenuOpen}
        >
          <div class="dropdown-menu-content">
            <vscode-checkbox
              id="attachTeXCount"
              ?checked=${this.currentCheckboxValues.attachTeXCount}
              ?disabled=${this.isToolUseSession}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'attachTeXCount',
                  (event.target as HTMLInputElement).checked,
                )}
            >
              Attach TeX Count
            </vscode-checkbox>
            <vscode-checkbox
              id="attachDiagnostics"
              ?checked=${this.currentCheckboxValues.attachDiagnostics}
              ?disabled=${this.isToolUseSession}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'attachDiagnostics',
                  (event.target as HTMLInputElement).checked,
                )}
            >
              Attach Diagnostics
            </vscode-checkbox>
          </div>
        </vscode-context-menu>
      </div>
    `;
  }

  private renderAutoExtractMenu(): TemplateResult {
    const hasChecked =
      this.currentCheckboxValues.autoExtractFigure ||
      this.currentCheckboxValues.autoExtractTikzFigure ||
      this.currentCheckboxValues.autoCompileInputPdf;
    const chevronClass = this.autoExtractMenuOpen
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';

    return html`
      <div class="dropdown-container">
        <vscode-toolbar-button
          id="toggleAutoExtract"
          icon="wand"
          title="Auto-extract options"
          toggleable
          aria-haspopup="true"
          aria-expanded=${this.autoExtractMenuOpen ? 'true' : 'false'}
          ?checked=${hasChecked}
          @click=${() => this.toggleMenu('autoExtract')}
        >
          <i class="codicon ${chevronClass}"></i>
        </vscode-toolbar-button>
        <vscode-context-menu
          id="autoExtractOptions"
          class="dropdown-menu"
          ?show=${this.autoExtractMenuOpen}
        >
          <div class="dropdown-menu-content">
            <vscode-checkbox
              id="autoExtractFigure"
              ?checked=${this.currentCheckboxValues.autoExtractFigure}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'autoExtractFigure',
                  (event.target as HTMLInputElement).checked,
                )}
            >
              Figures
            </vscode-checkbox>
            <vscode-checkbox
              id="autoExtractTikzFigure"
              ?checked=${this.currentCheckboxValues.autoExtractTikzFigure}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'autoExtractTikzFigure',
                  (event.target as HTMLInputElement).checked,
                )}
            >
              TikZ Figures
            </vscode-checkbox>
            <vscode-checkbox
              id="autoCompileInputPdf"
              ?checked=${this.currentCheckboxValues.autoCompileInputPdf}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'autoCompileInputPdf',
                  (event.target as HTMLInputElement).checked,
                )}
            >
              Compile Input PDF
            </vscode-checkbox>
          </div>
        </vscode-context-menu>
      </div>
    `;
  }

  private renderFileList(): TemplateResult {
    if (this.currentFiles.length === 0) {
      return html`<div class="file-list-placeholder">No files selected.</div>`;
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
    const { config } = this;
    const toggleId = `toggle${config.type[0].toUpperCase()}${config.type.slice(1)}Files`;
    const chevronClass = this.currentListVisible
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';

    return html`
      <div
        class="file-select"
        data-expanded=${String(this.currentListVisible)}
        @focusout=${this.handleFocusOut}
      >
        <div class="file-select-header">
          <div class="file-select-label-group">
            <vscode-toolbar-button
              id="refresh${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FileButton"
              icon=${config.icon}
              label=${config.refreshTitle}
              title=${config.refreshTitle}
              @click=${this.handleRefreshFiles}
            ></vscode-toolbar-button>
            <label for=${this.selectId} title=${config.tooltip}
              >${config.label}</label
            >
            ${when(config.toolConfig === 'tool', () =>
              this.renderToolConfigMenu(),
            )}
            ${when(config.toolConfig === 'autoExtract', () =>
              this.renderAutoExtractMenu(),
            )}
          </div>
          <vscode-toolbar-container class="file-select-actions">
            <vscode-toolbar-button
              id="current${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FileButton"
              icon="file-code"
              label=${config.currentTitle}
              title=${config.currentTitle}
              @click=${this.handleGetCurrentFile}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="empty${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FileButton"
              icon="close"
              label=${config.emptyTitle}
              title=${config.emptyTitle}
              @click=${this.handleEmptyFile}
            ></vscode-toolbar-button>
            <span
              id=${toggleId}
              class="toggle-icon"
              title=${config.toggleTitle}
              @click=${this.handleToggleList}
            >
              <i class="codicon ${chevronClass}"></i>
            </span>
            <vscode-toolbar-button
              id="addOpened${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton"
              class="file-action-button"
              icon="folder-opened"
              label=${config.addOpenedLabel}
              title=${config.addOpenedLabel}
              @click=${this.handleAddOpenedFiles}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="empty${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton"
              class="file-action-button"
              icon="trash"
              label=${config.emptyListLabel}
              title=${config.emptyListLabel}
              @click=${this.handleEmptyFiles}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="select${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton"
              class="file-action-button"
              icon="add"
              label=${config.selectListLabel}
              title=${config.selectListLabel}
              @click=${this.handleSelectMultipleFiles}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>
        <vscode-single-select
          id=${this.selectId}
          .value=${this.currentSelectedValue}
          @focus=${this.handleFocus}
          @change=${(event: Event) => {
            const target = event.currentTarget as HTMLInputElement;
            this.handleFileChange(target.value);
          }}
        >
          ${this.renderFileOptions()}
        </vscode-single-select>
        <div
          id="${this.listId}Container"
          class="multiple-files-container"
          style=${styleMap({
            display: this.currentListVisible ? 'block' : 'none',
          })}
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
}

declare global {
  interface HTMLElementTagNameMap {
    'file-select-group': FileSelectGroup;
  }
}
