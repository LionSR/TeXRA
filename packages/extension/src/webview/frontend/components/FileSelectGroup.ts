import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import type WaCheckbox from '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';

import { SortableController } from '@shared/controllers';
import { designTokens, codiconStyles } from '@shared/styles';
import type { CheckboxValues, FileSelectConfig } from '@shared/schemas';
import { ensureContextMenuUsesSlot } from '@shared/utils/dom';
import { getBasename, normalizeFilePath } from '@shared/utils/path';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { type TeXRAIconName, waIcon } from '@shared/wa/webAwesomeIcons';
import { MainViewEvents } from '../events';
import { SESSION_TYPES } from '../constants';
import { SESSION_DEFAULTS } from '../sessionDefaults';
import {
  fileStateContext,
  type FileStateContextValue,
} from '../contexts/mainViewContexts';
import { fileSelectStyles } from '../styles/fileSelectStyles';
import { DEFAULT_CHECKBOX_VALUES } from '../store';

@customElement('file-select-group')
export class FileSelectGroup extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    ...fileSelectStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  /** File type configuration */
  @property({ attribute: false }) config!: FileSelectConfig;

  @consume({ context: fileStateContext, subscribe: true })
  private fileState?: FileStateContextValue;

  /** Auto-extract menu open state */
  @state() private autoExtractMenuOpen = false;

  /** Tool config menu open state */
  @state() private toolConfigMenuOpen = false;

  @query('.multiple-files-list')
  private fileListElement?: HTMLElement;

  @query('#toolConfigOptions')
  private toolConfigMenu?: HTMLElement;

  @query('#autoExtractOptions')
  private autoExtractMenu?: HTMLElement;

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

    // Workaround for vscode-context-menu slot rendering
    ensureContextMenuUsesSlot(this.toolConfigMenu);
    ensureContextMenuUsesSlot(this.autoExtractMenu);
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

  private handleRemoveClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-remove-file]',
    );
    if (!button) return;
    const file = button.dataset.removeFile;
    if (file) {
      this.dispatchEvent(
        MainViewEvents.removeFile({ listId: this.listId, file }),
      );
    }
  }

  private handleCheckboxChange(id: string, checked: boolean): void {
    this.dispatchEvent(MainViewEvents.checkboxChange({ id, checked }));
  }

  private handleSelectChange(event: Event): void {
    const target = event.currentTarget as WaSelect | null;
    const value = target?.value;
    this.handleFileChange(typeof value === 'string' ? value : '');
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

    if (nextTarget !== null && this.isWithinComponent(nextTarget)) return;
    this.autoExtractMenuOpen = false;
    this.toolConfigMenuOpen = false;
  }

  private isWithinComponent(target: Node): boolean {
    if (this.contains(target) || this.shadowRoot?.contains(target)) {
      return true;
    }

    const MAX_SHADOW_DEPTH = 20;
    let root = target.getRootNode();
    let depth = 0;
    while (root instanceof ShadowRoot && depth < MAX_SHADOW_DEPTH) {
      if (this.contains(root.host)) {
        return true;
      }
      root = root.host.getRootNode();
      depth++;
    }

    return false;
  }

  private renderFileOptions(): TemplateResult {
    const sortedOptions = [...this.currentOptions].sort((a, b) =>
      a.localeCompare(b),
    );
    return html`
      <wa-option value="">None</wa-option>
      ${repeat(
        sortedOptions,
        (opt) => opt,
        (opt) => html` <wa-option value=${opt}>${opt}</wa-option> `,
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
        <wa-button
          id="toggleToolConfig"
          class=${classMap({
            'action-icon-button': true,
            'has-options': hasChecked,
          })}
          appearance="plain"
          variant="neutral"
          size="small"
          type="button"
          aria-label="Tool configuration options"
          title="Tool configuration options"
          aria-haspopup="true"
          aria-expanded=${this.toolConfigMenuOpen ? 'true' : 'false'}
          @click=${() => this.toggleMenu('toolConfig')}
        >
          ${waIcon('tools', { slot: 'start' })}
          <i class="codicon ${chevronClass}"></i>
        </wa-button>
        <vscode-context-menu
          id="toolConfigOptions"
          class="dropdown-menu"
          ?show=${this.toolConfigMenuOpen}
        >
          <div class="dropdown-menu-content">
            <wa-checkbox
              id="attachTeXCount"
              ?checked=${this.currentCheckboxValues.attachTeXCount}
              ?disabled=${this.isFileInputDisabled}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'attachTeXCount',
                  (event.target as WaCheckbox).checked,
                )}
            >
              Attach TeX Count
            </wa-checkbox>
            <wa-checkbox
              id="attachDiagnostics"
              ?checked=${this.currentCheckboxValues.attachDiagnostics}
              ?disabled=${this.isFileInputDisabled}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'attachDiagnostics',
                  (event.target as WaCheckbox).checked,
                )}
            >
              Attach Diagnostics
            </wa-checkbox>
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
        <wa-button
          id="toggleAutoExtract"
          class=${classMap({
            'action-icon-button': true,
            'has-options': hasChecked,
          })}
          appearance="plain"
          variant="neutral"
          size="small"
          type="button"
          aria-label="Auto-extract options"
          title="Auto-extract options"
          aria-haspopup="true"
          aria-expanded=${this.autoExtractMenuOpen ? 'true' : 'false'}
          @click=${() => this.toggleMenu('autoExtract')}
        >
          ${waIcon('wand', { slot: 'start' })}
          <i class="codicon ${chevronClass}"></i>
        </wa-button>
        <vscode-context-menu
          id="autoExtractOptions"
          class="dropdown-menu"
          ?show=${this.autoExtractMenuOpen}
        >
          <div class="dropdown-menu-content">
            <wa-checkbox
              id="autoExtractFigure"
              ?checked=${this.currentCheckboxValues.autoExtractFigure}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'autoExtractFigure',
                  (event.target as WaCheckbox).checked,
                )}
            >
              Figures
            </wa-checkbox>
            <wa-checkbox
              id="autoExtractTikzFigure"
              ?checked=${this.currentCheckboxValues.autoExtractTikzFigure}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'autoExtractTikzFigure',
                  (event.target as WaCheckbox).checked,
                )}
            >
              TikZ Figures
            </wa-checkbox>
            <wa-checkbox
              id="autoCompileInputPdf"
              ?checked=${this.currentCheckboxValues.autoCompileInputPdf}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'autoCompileInputPdf',
                  (event.target as WaCheckbox).checked,
                )}
            >
              Compile Input PDF
            </wa-checkbox>
          </div>
        </vscode-context-menu>
      </div>
    `;
  }

  private renderFileList(): TemplateResult {
    if (this.currentFiles.length === 0) {
      return html`<div class="file-list-placeholder">No files selected.</div>`;
    }

    return html`<div @click=${this.handleRemoveClick}>
      ${repeat(
        this.currentFiles,
        (file) => file,
        (file) => {
          const display = this.formatFilePath(file);
          return html`
            <div class="file-item" data-path=${file} title=${file}>
              <span class="file-name">
                <span class="file-name-main">${display.name}</span>
                ${display.folder
                  ? html`<span class="file-folder">
                      <i class="codicon codicon-folder" aria-hidden="true"></i>
                      ${display.folder}
                    </span>`
                  : nothing}
              </span>
              <button
                class="remove-button codicon codicon-trash"
                type="button"
                aria-label="Remove file"
                data-remove-file=${file}
              ></button>
            </div>
          `;
        },
      )}
    </div>`;
  }

  private formatFilePath(file: string): { name: string; folder: string } {
    const normalized = normalizeFilePath(file);
    const name = getBasename(normalized) || normalized;
    const folder = normalized.slice(
      0,
      Math.max(0, normalized.length - name.length),
    );
    return {
      name,
      folder: folder.replace(/\/$/, ''),
    };
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
            ${renderIconActionButton({
              id: `refresh${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FileButton`,
              icon: config.icon as TeXRAIconName,
              label: config.refreshTitle,
              title: config.refreshTitle,
              onClick: this.handleRefreshFiles,
            })}
            <label for=${this.selectId} title=${config.tooltip}
              >${config.label}</label
            >
            ${when(config.toolConfig === 'tool', () =>
              this.renderToolConfigMenu(),
            )}
            ${when(config.toolConfig === 'autoExtract', () =>
              this.renderAutoExtractMenu(),
            )}
            ${config.description
              ? html`<span class="file-select-hint" title=${config.description}
                  >${config.description}</span
                >`
              : nothing}
          </div>
          <div class="file-select-actions">
            ${renderIconActionButton({
              id: `current${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FileButton`,
              icon: 'file-code',
              label: config.currentTitle,
              title: config.currentTitle,
              onClick: this.handleGetCurrentFile,
            })}
            ${renderIconActionButton({
              id: `empty${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FileButton`,
              icon: 'close',
              label: config.emptyTitle,
              title: config.emptyTitle,
              onClick: this.handleEmptyFile,
            })}
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
            ${renderIconActionButton({
              id: `addOpened${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton`,
              icon: 'folder-opened',
              label: config.addOpenedLabel,
              title: config.addOpenedLabel,
              className: 'file-action-button',
              onClick: this.handleAddOpenedFiles,
            })}
            ${renderIconActionButton({
              id: `empty${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton`,
              icon: 'trash',
              label: config.emptyListLabel,
              title: config.emptyListLabel,
              className: 'file-action-button',
              onClick: this.handleEmptyFiles,
            })}
            ${renderIconActionButton({
              id: `select${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton`,
              icon: 'add',
              label: config.selectListLabel,
              title: config.selectListLabel,
              className: 'file-action-button',
              onClick: this.handleSelectMultipleFiles,
            })}
          </div>
        </div>
        <wa-select
          id=${this.selectId}
          .value=${this.currentSelectedValue}
          @focus=${this.handleFocus}
          @change=${this.handleSelectChange}
        >
          ${this.renderFileOptions()}
        </wa-select>
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
