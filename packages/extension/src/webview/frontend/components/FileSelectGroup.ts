import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, property, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

import { designTokens } from '@shared/styles';
import type {
  CheckboxValues,
  DocumentFileType,
  FileSelectConfig,
} from '@shared/schemas';
import { SortableController } from '@shared/litControllers/SortableController';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { type TeXRAIconName, waIcon } from '@shared/wa/webAwesomeIcons';
import { getBasename, normalizeFilePath } from '@utils/core';
import { capitalize } from '@utils/text/stringUtils';
import { MainViewEvents } from '../events';
import { FileDropController, postDroppedFiles } from '../fileDropHandler';
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

  private fileDrop = new FileDropController(this, (paths) =>
    postDroppedFiles(paths, this.config.type),
  );

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

  protected override updated(changedProps: Map<string, unknown>): void {
    if (changedProps.has('config')) {
      this.sortableController.reinitialize();
    }
  }

  private get listId(): `${DocumentFileType}Files` {
    return `${this.config.type}Files`;
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

  private get currentCheckboxValues(): CheckboxValues {
    return this.fileState?.checkboxValues ?? DEFAULT_CHECKBOX_VALUES;
  }

  private get currentFiles(): string[] {
    return this.fileState?.multiFiles[this.listId] ?? [];
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
      (HTMLElement & { value?: string; checked?: boolean }) | undefined;
    const id = item?.value;
    if (!id) return;
    this.handleCheckboxChange(id, Boolean(item?.checked));
  };

  /** Shared wa-dropdown chrome (trigger button + tooltip) for the checkbox menus. */
  private renderConfigDropdown(opts: {
    id: string;
    icon: TeXRAIconName;
    label: string;
    hasOptions: boolean;
    items: TemplateResult;
  }): TemplateResult {
    return html`
      <wa-dropdown placement="bottom-start" @wa-select=${this.handleMenuSelect}>
        <wa-button
          slot="trigger"
          id=${opts.id}
          class=${classMap({
            'action-icon-button': true,
            'has-options': opts.hasOptions,
          })}
          appearance="plain"
          variant="neutral"
          size="small"
          type="button"
          aria-label=${opts.label}
        >
          ${waIcon(opts.icon)}
        </wa-button>
        ${opts.items}
      </wa-dropdown>
      <wa-tooltip for=${opts.id}>${opts.label}</wa-tooltip>
    `;
  }

  private renderToolConfigMenu(): TemplateResult {
    const values = this.currentCheckboxValues;
    return this.renderConfigDropdown({
      id: 'toggleToolConfig',
      icon: 'tools',
      label: 'Tool configuration options',
      hasOptions: Boolean(values.attachTeXCount),
      items: html`
        <wa-dropdown-item
          type="checkbox"
          value="attachTeXCount"
          ?checked=${values.attachTeXCount}
          ?disabled=${this.isFileInputDisabled}
        >
          Attach TeX Count
        </wa-dropdown-item>
      `,
    });
  }

  private renderAutoExtractMenu(): TemplateResult {
    const values = this.currentCheckboxValues;
    return this.renderConfigDropdown({
      id: 'toggleAutoExtract',
      icon: 'wand',
      label: 'Auto-extract options',
      hasOptions:
        values.autoExtractFigure ||
        values.autoExtractTikzFigure ||
        values.autoCompileInputPdf,
      items: html`
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
      `,
    });
  }

  private renderFileList(): TemplateResult {
    if (this.currentFiles.length === 0) {
      return html`<div class="file-list-placeholder">No files selected.</div>`;
    }

    return html`<div @click=${this.handleRemoveClick}>
      ${repeat(
        this.currentFiles,
        (file) => file,
        (file, index) => {
          const display = this.formatFilePath(file);
          // Per-row id so the sibling <wa-tooltip> anchors to the right row
          // (this list renders in a single shadow root). The repeat index is
          // unique and collision-proof, unlike a sanitized path.
          const removeButtonId = `file-select-remove-${index}`;
          return html`
            <div class="file-item" data-path=${file} title=${file}>
              <span class="file-name">
                <span class="file-name-main">${display.name}</span>
                ${
                  display.folder
                    ? html`<span class="file-folder">
                        ${waIcon('folder')} ${display.folder}
                      </span>`
                    : nothing
                }
              </span>
              <wa-button
                id=${removeButtonId}
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
              <wa-tooltip for=${removeButtonId}>Remove file</wa-tooltip>
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
    const typeLabel = capitalize(config.type);

    return html`
      <div
        class=${classMap({
          'file-select': true,
          'drop-active': this.fileDrop.isDragActive,
        })}
        @dragenter=${this.fileDrop.handleDragEnter}
        @dragover=${this.fileDrop.handleDragOver}
        @dragleave=${this.fileDrop.handleDragLeave}
        @drop=${this.fileDrop.handleDrop}
      >
        <div class="file-select-header">
          <div class="file-select-label-group">
            <span class="file-select-icon" aria-hidden="true">
              ${waIcon(config.icon as TeXRAIconName)}
            </span>
            <label id="${this.listId}Label">${config.label}</label>
            <wa-tooltip for="${this.listId}Label">${config.tooltip}</wa-tooltip>
            ${
              config.toolConfig === 'tool'
                ? this.renderToolConfigMenu()
                : nothing
            }
            ${
              config.toolConfig === 'autoExtract'
                ? this.renderAutoExtractMenu()
                : nothing
            }
            ${
              config.description
                ? html`<span
                    class="file-select-hint"
                    title=${config.description}
                    >${config.description}</span
                  >`
                : nothing
            }
          </div>
          <div class="file-select-actions">
            ${renderIconActionButton({
              id: `addOpened${typeLabel}FilesButton`,
              icon: 'folder-opened',
              label: config.addOpenedLabel,
              tooltip: config.addOpenedLabel,
              onClick: this.handleAddOpenedFiles,
            })}
            ${renderIconActionButton({
              id: `empty${typeLabel}FilesButton`,
              icon: 'trash',
              label: config.emptyListLabel,
              tooltip: config.emptyListLabel,
              onClick: this.handleEmptyFiles,
            })}
            ${renderIconActionButton({
              id: `select${typeLabel}FilesButton`,
              icon: 'add',
              label: config.selectListLabel,
              tooltip: config.selectListLabel,
              onClick: this.handleSelectMultipleFiles,
            })}
          </div>
        </div>
        <div id="${this.listId}Container" class="multiple-files-container">
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
