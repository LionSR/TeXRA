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
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { getBasename, normalizeFilePath } from '@utils/core';
import { capitalize } from '@utils/text/stringUtils';
import { MainViewEvents } from '../events';
import { FileDropController, postDroppedFiles } from '../fileDropHandler';
import { SESSION_TYPES } from '../constants';
import { SESSION_DEFAULTS } from '../sessionDefaults';
import {
  fileStateContext,
  type FileStateContextValue,
} from '../mainViewContexts';
import { fileSelectStyles } from '../fileSelectStyles';
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

  private handleRemoveClick(button: HTMLElement): void {
    const file = button.dataset.removeFile;
    if (file) {
      this.dispatchEvent(
        MainViewEvents.removeFile({ listId: this.listId, file }),
      );
    }
  }

  /** Keyboard/touch counterpart to Sortable drag reordering (order is
   * semantic: the first input file is the primary input). Dispatches the
   * same filesReordered event as a drag. */
  private handleMoveClick(button: HTMLElement): void {
    const index = Number(button.dataset.moveIndex);
    const direction = Number(button.dataset.moveDirection);
    const files = this.currentFiles;
    const target = index + direction;
    if (!Number.isInteger(index) || target < 0 || target >= files.length) {
      return;
    }
    const reordered = [...files];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    this.dispatchEvent(
      MainViewEvents.filesReordered({ listId: this.listId, files: reordered }),
    );
  }

  /** Single delegate for the file-list row: lit-html rejects two `@click`
   * bindings on the same element, so remove and move share one dispatch,
   * each matching its own `data-*` marker on a distinct button. */
  private handleFileListClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const removeButton = target.closest<HTMLElement>('[data-remove-file]');
    if (removeButton) {
      this.handleRemoveClick(removeButton);
      return;
    }
    const moveButton = target.closest<HTMLElement>('[data-move-index]');
    if (moveButton) {
      this.handleMoveClick(moveButton);
    }
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
    this.dispatchEvent(
      MainViewEvents.checkboxChange({ id, checked: Boolean(item?.checked) }),
    );
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
          size="s"
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
      icon: 'screwdriver-wrench',
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
      icon: 'wand-magic-sparkles',
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

    const movable = this.currentFiles.length > 1;
    return html`<div role="list" @click=${this.handleFileListClick}>
      ${repeat(
        this.currentFiles,
        (file) => file,
        (file, index) => {
          const display = this.formatFilePath(file);
          // Per-row id so the sibling <wa-tooltip> anchors to the right row
          // (this list renders in a single shadow root). The repeat index is
          // unique and collision-proof, unlike a sanitized path.
          const moveUpButtonId = `file-select-move-up-${index}`;
          const moveDownButtonId = `file-select-move-down-${index}`;
          const removeButtonId = `file-select-remove-${index}`;
          return html`
            <div
              class="file-item"
              role="listitem"
              data-path=${file}
              title=${file}
            >
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
              ${
                movable
                  ? html`
                      <wa-button
                        id=${moveUpButtonId}
                        class="action-icon-button move-button"
                        appearance="plain"
                        variant="neutral"
                        size="s"
                        type="button"
                        aria-label=${`Move ${display.name} up`}
                        data-move-index=${index}
                        data-move-direction="-1"
                        ?disabled=${index === 0}
                      >
                        ${waIcon('arrow-up')}
                      </wa-button>
                      <wa-tooltip for=${moveUpButtonId}
                        >Move up: ${file}</wa-tooltip
                      >
                      <wa-button
                        id=${moveDownButtonId}
                        class="action-icon-button move-button"
                        appearance="plain"
                        variant="neutral"
                        size="s"
                        type="button"
                        aria-label=${`Move ${display.name} down`}
                        data-move-index=${index}
                        data-move-direction="1"
                        ?disabled=${index === this.currentFiles.length - 1}
                      >
                        ${waIcon('arrow-down')}
                      </wa-button>
                      <wa-tooltip for=${moveDownButtonId}
                        >Move down: ${file}</wa-tooltip
                      >
                    `
                  : nothing
              }
              <wa-button
                id=${removeButtonId}
                class="action-icon-button remove-button"
                appearance="plain"
                variant="neutral"
                size="s"
                type="button"
                aria-label=${`Remove ${display.name}`}
                data-remove-file=${file}
              >
                ${waIcon('trash')}
              </wa-button>
              <wa-tooltip for=${removeButtonId}>Remove: ${file}</wa-tooltip>
            </div>
          `;
        },
      )}
    </div>`;
  }

  private formatFilePath(file: string): { name: string; folder: string } {
    const normalized = normalizeFilePath(file);
    // getBasename returns a trailing substring of `normalized` (or the whole
    // string on the fallback), so the length difference can't go negative.
    const name = getBasename(normalized) || normalized;
    const folder = normalized.slice(0, normalized.length - name.length);
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
              ${waIcon(config.icon)}
            </span>
            <span class="file-select-label">${config.label}</span>
            ${
              this.currentFiles.length > 1
                ? html`<span class="file-select-count">
                    ${this.currentFiles.length} files
                  </span>`
                : nothing
            }
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
          </div>
          <div class="file-select-actions">
            ${renderIconActionButton({
              id: `addOpened${typeLabel}FilesButton`,
              icon: 'folder-open',
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
              icon: 'plus',
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
