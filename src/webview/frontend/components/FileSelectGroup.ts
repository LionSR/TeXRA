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
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - main view
import { SortableController } from '@shared/controllers';
import { codiconStyles } from '@shared/styles';
import { MainViewEvents } from '../events';
import { SESSION_TYPES } from '../constants';
import { SESSION_DEFAULTS } from '../sessionDefaults';
import {
  fileStateContext,
  type FileStateContextValue,
} from '../contexts/mainViewContexts';
import { fileSelectStyles } from '../styles/fileSelectStyles';

// Local imports - shared schemas
import { DEFAULT_CHECKBOX_VALUES } from '../store';
import type { CheckboxValues, FileSelectConfig } from '@shared/schemas';

@customElement('file-select-group')
export class FileSelectGroup extends LitElement {
  static override styles = [
    codiconStyles,
    ...fileSelectStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

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

  private sortableController = new SortableController(
    this,
    () => this.fileListElement,
    () => this.currentFiles,
    (result) =>
      this.dispatchEvent(
        MainViewEvents.filesReordered({
          listId: this.listId,
          files: result.items,
        }),
      ),
  );

  /** Track previous expanded state to detect visibility changes */
  private wasExpanded = false;

  protected override updated(changedProps: Map<string, unknown>): void {
    const isExpanded = this.currentListVisible;
    if (changedProps.has('config') || (isExpanded && !this.wasExpanded)) {
      this.sortableController.reinitialize();
    }
    this.wasExpanded = isExpanded;
  }

  private get listId(): string {
    return `${this.config.type}Files`;
  }

  private get selectId(): string {
    return `${this.config.type}File`;
  }

  private toggleMenu(type: 'autoExtract' | 'toolConfig'): void {
    const wasOpen =
      type === 'autoExtract'
        ? this.autoExtractMenuOpen
        : this.toolConfigMenuOpen;
    // Close both menus first, then toggle the requested one
    this.autoExtractMenuOpen = type === 'autoExtract' && !wasOpen;
    this.toolConfigMenuOpen = type === 'toolConfig' && !wasOpen;
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

  private handleSelectChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement | null;
    this.handleFileChange(target?.value ?? '');
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

  private get isFileInputDisabled(): boolean {
    const sessionType = this.fileState?.sessionType ?? SESSION_TYPES.WORKFLOW;
    return !SESSION_DEFAULTS[sessionType].fileInputEnabled;
  }

  private handleFocusOut(event: FocusEvent): void {
    const root = this.getRootNode();
    const activeElement =
      root instanceof Document || root instanceof ShadowRoot
        ? root.activeElement
        : null;
    const nextTarget = (event.relatedTarget ?? activeElement) as Node | null;

    if (nextTarget === null) {
      this.autoExtractMenuOpen = false;
      this.toolConfigMenuOpen = false;
      return;
    }

    const staysInComponent = this.isWithinComponent(nextTarget);
    if (staysInComponent) return;
    this.autoExtractMenuOpen = false;
    this.toolConfigMenuOpen = false;
  }

  private isWithinComponent(target: Node): boolean {
    if (this.contains(target) || this.shadowRoot?.contains(target)) {
      return true;
    }

    let root = target.getRootNode();
    while (root instanceof ShadowRoot) {
      if (this.contains(root.host)) {
        return true;
      }
      root = root.host.getRootNode();
    }

    return false;
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
          class=${classMap({ 'has-options': hasChecked })}
          ?checked=${this.toolConfigMenuOpen}
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
              ?disabled=${this.isFileInputDisabled}
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
              ?disabled=${this.isFileInputDisabled}
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
          class=${classMap({ 'has-options': hasChecked })}
          ?checked=${this.autoExtractMenuOpen}
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
          <button
            class="remove-button codicon codicon-trash"
            type="button"
            aria-label="Remove file"
            @click=${() => this.handleRemoveFile(file)}
          ></button>
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
            <button
              id=${toggleId}
              class="toggle-icon"
              title=${config.toggleTitle}
              type="button"
              aria-label=${config.toggleTitle}
              @click=${this.handleToggleList}
            >
              <i class="codicon ${chevronClass}"></i>
            </button>
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
          @change=${this.handleSelectChange}
        >
          ${this.renderFileOptions()}
        </vscode-single-select>
        ${when(
          this.currentListVisible,
          () => html`
            <div id="${this.listId}Container" class="multiple-files-container">
              <div class="multiple-files-content">
                <div id=${this.listId} class="multiple-files-list">
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
    'file-select-group': FileSelectGroup;
  }
}
