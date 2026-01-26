/**
 * FileSelectGroup component for MainView file selection.
 *
 * Renders a file selection dropdown with optional multiple files list,
 * and optional tool config / auto-extract menus.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared utils
import { markOptionAsSelected, withPlaceholder } from '@shared/utils/dropdown';

// Local imports - main view
import { MainViewEvents } from '../events';

// Local imports - shared schemas
import type { CheckboxValues, FileSelectConfig } from '@shared/schemas';

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

  /** Currently selected value */
  @property({ type: String }) selectedValue = '';

  /** Available file options */
  @property({ type: Array }) options: string[] = [];

  /** Whether the multiple files list is visible */
  @property({ type: Boolean }) listVisible = false;

  /** Files in the multiple files list */
  @property({ type: Array }) files: string[] = [];

  /** Checkbox values for menus */
  @property({ type: Object }) checkboxValues: CheckboxValues = {
    autoExtractFigure: false,
    autoExtractTikzFigure: false,
    autoCompileInputPdf: false,
    attachTeXCount: false,
    attachDiagnostics: false,
  };

  /** Whether this is tool-use session (disables some checkboxes) */
  @property({ type: Boolean }) isToolUse = false;

  /** Auto-extract menu open state */
  @state() private autoExtractMenuOpen = false;

  /** Tool config menu open state */
  @state() private toolConfigMenuOpen = false;

  /** Document click handler bound to this instance */
  private readonly boundDocumentClickHandler =
    this.handleDocumentClick.bind(this);

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('click', this.boundDocumentClickHandler);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('click', this.boundDocumentClickHandler);
    super.disconnectedCallback();
  }

  private handleDocumentClick(event: MouseEvent): void {
    // Only handle if a menu is open
    if (!this.autoExtractMenuOpen && !this.toolConfigMenuOpen) {
      return;
    }

    const path = event.composedPath();
    const clickedInside = path.some(
      (el) => el instanceof HTMLElement && el.getRootNode() === this.shadowRoot,
    );

    // If clicked outside this component, close all menus
    if (!clickedInside) {
      this.autoExtractMenuOpen = false;
      this.toolConfigMenuOpen = false;
    }
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

  private buildOptionsHtml(): string {
    const htmlOptions = [...this.options]
      .sort((a, b) => a.localeCompare(b))
      .map(
        (value) => `<vscode-option value="${value}">${value}</vscode-option>`,
      )
      .join('\n');
    const withPlaceholderHtml = withPlaceholder(
      htmlOptions,
      '<vscode-option value="">None</vscode-option>',
    );
    return markOptionAsSelected(withPlaceholderHtml, this.selectedValue);
  }

  private renderToolConfigMenu(): TemplateResult {
    const hasChecked =
      this.checkboxValues.attachTeXCount ||
      this.checkboxValues.attachDiagnostics;
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
              ?checked=${this.checkboxValues.attachTeXCount}
              ?disabled=${this.isToolUse}
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
              ?checked=${this.checkboxValues.attachDiagnostics}
              ?disabled=${this.isToolUse}
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
      this.checkboxValues.autoExtractFigure ||
      this.checkboxValues.autoExtractTikzFigure ||
      this.checkboxValues.autoCompileInputPdf;
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
              ?checked=${this.checkboxValues.autoExtractFigure}
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
              ?checked=${this.checkboxValues.autoExtractTikzFigure}
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
              ?checked=${this.checkboxValues.autoCompileInputPdf}
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
            @click=${() => this.handleRemoveFile(file)}
          ></span>
        </div>
      `,
    )}`;
  }

  override render(): TemplateResult {
    const { config } = this;
    const toggleId = `toggle${config.type[0].toUpperCase()}${config.type.slice(1)}Files`;
    const chevronClass = this.listVisible
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';

    return html`
      <div class="file-select" data-expanded=${String(this.listVisible)}>
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
          .value=${this.selectedValue}
          @focus=${this.handleFocus}
          @change=${(event: Event) => {
            const target = event.currentTarget as HTMLInputElement;
            this.handleFileChange(target.value);
          }}
        >
          ${unsafeHTML(this.buildOptionsHtml())}
        </vscode-single-select>
        <div
          id="${this.listId}Container"
          class="multiple-files-container"
          style=${styleMap({ display: this.listVisible ? 'block' : 'none' })}
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
