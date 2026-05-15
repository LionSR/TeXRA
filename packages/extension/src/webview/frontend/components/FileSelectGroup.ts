import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';

import { SortableController } from '@shared/controllers';
import { designTokens } from '@shared/styles';
import type { CheckboxValues, FileSelectConfig } from '@shared/schemas';
import { getBasename, normalizeFilePath } from '@shared/utils/path';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { type TeXRAIconName, waIcon } from '@shared/wa/webAwesomeIcons';
import { MainViewEvents } from '../events';
import {
  extractDroppedFilePaths,
  hasDroppedFilePayload,
  postDroppedFiles,
} from '../fileDropHandler';
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
    ...fileSelectStyles,
    css`
      :host {
        display: block;
      }

      .file-select.drop-active {
        outline: 1px dashed var(--wa-color-brand-fill-loud);
        outline-offset: 2px;
        background: color-mix(
          in srgb,
          var(--wa-color-brand-fill-quiet) 22%,
          transparent
        );
      }
    `,
  ];

  /** File type configuration */
  @property({ attribute: false }) config!: FileSelectConfig;

  @consume({ context: fileStateContext, subscribe: true })
  private fileState?: FileStateContextValue;

  @query('.multiple-files-list')
  private fileListElement?: HTMLElement;

  @state()
  private isDragActive = false;

  private dragDepth = 0;

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

  private handleDragEnter(event: DragEvent): void {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.isDragActive = true;
  }

  private handleDragOver(event: DragEvent): void {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  private handleDragLeave(event: DragEvent): void {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.isDragActive = false;
    }
  }

  private handleDrop(event: DragEvent): void {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.isDragActive = false;
    postDroppedFiles(
      extractDroppedFilePaths(event.dataTransfer),
      this.config.type,
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

  private get currentCheckboxValues(): CheckboxValues {
    return this.fileState?.checkboxValues ?? DEFAULT_CHECKBOX_VALUES;
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

  /**
   * Handle wa-select on the checkbox-type dropdown items: keep the menu open
   * (preventDefault), translate the toggle into a checkboxChange event,
   * and react to the auto-toggle wa-dropdown applies before this fires.
   */
  private handleMenuSelect = (
    event: CustomEvent<{ item: HTMLElement }>,
  ): void => {
    event.preventDefault();
    const item = event.detail?.item as
      | (HTMLElement & { value?: string; checked?: boolean })
      | undefined;
    const id = item?.value;
    if (!id) return;
    this.handleCheckboxChange(id, Boolean(item?.checked));
  };

  private renderToolConfigMenu(): TemplateResult {
    const values = this.currentCheckboxValues;
    const hasChecked = values.attachTeXCount;
    const disabled = this.isFileInputDisabled;

    return html`
      <wa-dropdown placement="bottom-start" @wa-select=${this.handleMenuSelect}>
        <wa-button
          slot="trigger"
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
        >
          ${waIcon('tools')}
        </wa-button>
        <wa-dropdown-item
          type="checkbox"
          value="attachTeXCount"
          ?checked=${values.attachTeXCount}
          ?disabled=${disabled}
        >
          Attach TeX Count
        </wa-dropdown-item>
      </wa-dropdown>
    `;
  }

  private renderAutoExtractMenu(): TemplateResult {
    const values = this.currentCheckboxValues;
    const hasChecked =
      values.autoExtractFigure ||
      values.autoExtractTikzFigure ||
      values.autoCompileInputPdf;

    return html`
      <wa-dropdown placement="bottom-start" @wa-select=${this.handleMenuSelect}>
        <wa-button
          slot="trigger"
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
        >
          ${waIcon('wand')}
        </wa-button>
        <wa-dropdown-item
          type="checkbox"
          value="autoExtractFigure"
          ?checked=${values.autoExtractFigure}
        >
          Figures
        </wa-dropdown-item>
        <wa-dropdown-item
          type="checkbox"
          value="autoExtractTikzFigure"
          ?checked=${values.autoExtractTikzFigure}
        >
          TikZ Figures
        </wa-dropdown-item>
        <wa-dropdown-item
          type="checkbox"
          value="autoCompileInputPdf"
          ?checked=${values.autoCompileInputPdf}
        >
          Compile Input PDF
        </wa-dropdown-item>
      </wa-dropdown>
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
                      ${waIcon('folder')} ${display.folder}
                    </span>`
                  : nothing}
              </span>
              <wa-button
                class="action-icon-button remove-button"
                appearance="plain"
                variant="neutral"
                size="small"
                type="button"
                aria-label="Remove file"
                data-remove-file=${file}
              >
                ${waIcon('trash')}
              </wa-button>
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
    const chevronName = this.currentListVisible ? 'chevron-up' : 'chevron-down';

    return html`
      <div
        class=${classMap({
          'file-select': true,
          'drop-active': this.isDragActive,
        })}
        data-expanded=${String(this.currentListVisible)}
        @dragenter=${this.handleDragEnter}
        @dragover=${this.handleDragOver}
        @dragleave=${this.handleDragLeave}
        @drop=${this.handleDrop}
      >
        <div class="file-select-header">
          <div class="file-select-label-group">
            <span class="file-select-icon" aria-hidden="true">
              ${waIcon(config.icon as TeXRAIconName)}
            </span>
            <label title=${config.tooltip}>${config.label}</label>
            ${config.toolConfig === 'tool'
              ? this.renderToolConfigMenu()
              : nothing}
            ${config.toolConfig === 'autoExtract'
              ? this.renderAutoExtractMenu()
              : nothing}
            ${config.description
              ? html`<span class="file-select-hint" title=${config.description}
                  >${config.description}</span
                >`
              : nothing}
          </div>
          <div class="file-select-actions">
            <button
              id=${toggleId}
              class="toggle-icon"
              title=${config.toggleTitle}
              type="button"
              aria-label=${config.toggleTitle}
              @click=${this.handleToggleList}
            >
              ${waIcon(chevronName)}
            </button>
            ${renderIconActionButton({
              id: `addOpened${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton`,
              icon: 'folder-opened',
              label: config.addOpenedLabel,
              title: config.addOpenedLabel,
              onClick: this.handleAddOpenedFiles,
            })}
            ${renderIconActionButton({
              id: `empty${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton`,
              icon: 'trash',
              label: config.emptyListLabel,
              title: config.emptyListLabel,
              onClick: this.handleEmptyFiles,
            })}
            ${renderIconActionButton({
              id: `select${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton`,
              icon: 'add',
              label: config.selectListLabel,
              title: config.selectListLabel,
              onClick: this.handleSelectMultipleFiles,
            })}
          </div>
        </div>
        ${this.currentListVisible
          ? html`
              <div
                id="${this.listId}Container"
                class="multiple-files-container"
              >
                <div class="multiple-files-content">
                  <div id=${this.listId} class="multiple-files-list">
                    ${this.renderFileList()}
                  </div>
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'file-select-group': FileSelectGroup;
  }
}
