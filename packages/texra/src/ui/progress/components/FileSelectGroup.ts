import { formatResultCount } from '@texra-ai/harness/transcript';
import { getBasename, normalizeFilePath } from '@texra-ai/harness/schemas';
import { Record as Rec, Schema, String as Str } from 'effect';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import WaDropdownItem from '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

import type { DocumentFileType } from '@texra/shared/launcher/fileTypes';
import {
  DOCUMENT_TASK_OPTIONS,
  DocumentTaskOptionsSchema,
  type DocumentTaskOptions,
} from '@texra/shared/plugins/documents';
import type { SurfaceAction } from '@texra/shared/session/surface';
import { SessionUiEvents } from '@texra/shared/session/uiEvents';
import { SortableController } from '@ui/litControllers/SortableController';
import type { FileSelectConfig } from '@ui/copy/fileSelectConfigs';
import type { IconName } from '@ui/wa/iconNames';
import { dropCueStyles } from '@ui/styles/commonViewStyles';
import { designTokens } from '@ui/styles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { FileDropController, postDroppedFiles } from '../fileDropHandler';
import { fileSelectStyles } from '../fileSelectStyles';
import type { WaSelectEvent } from '@awesome.me/webawesome/dist/events/events.js';

/** The header menu a file group carries, by the group's type: its trigger's
 *  id, icon and tooltip. */
const MENUS: Partial<
  Record<DocumentFileType, { id: string; icon: IconName; label: string }>
> = {
  input: {
    id: 'toggleToolConfig',
    icon: 'screwdriver-wrench',
    label: 'Tool configuration options',
  },
  media: {
    id: 'toggleAutoExtract',
    icon: 'wand-magic-sparkles',
    label: 'Auto-extract options',
  },
};

@customElement('file-select-group')
export class FileSelectGroup extends LitElement {
  static override styles = [
    designTokens,
    ...fileSelectStyles,
    css`
      :host {
        display: block;
      }

      .file-select {
        position: relative;
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

      .drop-cue {
        ${dropCueStyles}
      }
    `,
  ];

  /** File type configuration */
  @property({ attribute: false }) config!: FileSelectConfig;

  /** The group's selected files, in order (`Surface.launch`). */
  @property({ attribute: false }) files: readonly string[] = [];

  /** The tool and auto-extract toggles (`Surface.launch`). */
  @property({ attribute: false }) checkboxValues: DocumentTaskOptions =
    Schema.decodeUnknownSync(DocumentTaskOptionsSchema)({});

  @query('.multiple-files-list')
  private fileListElement?: HTMLElement;

  private fileDrop = new FileDropController(this, (paths) =>
    postDroppedFiles(this, paths, this.config.type),
  );

  private sortableController = new SortableController(
    this,
    () => this.fileListElement,
    () => this.files,
    (result) => this.patchLaunch({ [this.listId]: result.items }),
  );

  private get listId(): `${DocumentFileType}Files` {
    return `${this.config.type}Files`;
  }

  /** A change to one of the launcher fields this group owns: its file list,
   *  or a toggle from one of its two config menus. */
  private patchLaunch(
    patch: Extract<SurfaceAction, { kind: 'launch' }>['patch'],
  ): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'launch', patch }));
  }

  private handleAddOpenedFiles(): void {
    this.dispatchEvent(
      SessionUiEvents.host({
        kind: 'addOpenedFiles',
        fileType: this.config.type,
      }),
    );
  }

  private handleEmptyFiles(): void {
    this.patchLaunch({ [this.listId]: [] });
  }

  private handleSelectMultipleFiles(): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'pickFiles', fileType: this.config.type }),
    );
  }

  private removeFile(file: string): void {
    this.patchLaunch({
      [this.listId]: this.files.filter((entry) => entry !== file),
    });
  }

  /** Keyboard/touch counterpart to Sortable drag reordering (order is
   * semantic: the first input file is the primary input). Patches the same
   * launcher list as a drag. */
  private moveFile(index: number, direction: -1 | 1): void {
    const files = this.files;
    const target = index + direction;
    if (target < 0 || target >= files.length) {
      return;
    }
    const reordered = [...files];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    this.patchLaunch({ [this.listId]: reordered });
  }

  /**
   * Handle wa-select on the checkbox-type dropdown items: keep the menu open
   * (preventDefault), patch the launcher field the item names, and react to
   * the auto-toggle wa-dropdown applies before this fires.
   */
  private handleMenuSelect = (event: WaSelectEvent): void => {
    event.preventDefault();
    const { item } = event.detail;
    if (!(item instanceof WaDropdownItem) || !item.value) return;
    this.patchLaunch({ [item.value]: item.checked });
  };

  /** The group's header menu: the task switches its file group offers
   *  (`DOCUMENT_TASK_OPTIONS`), none for a group that offers none. The
   *  group renders only for a document task (ProgressApp's file section),
   *  the one launch that reads these toggles. */
  private renderConfigMenu(): TemplateResult | typeof nothing {
    const menu = MENUS[this.config.type];
    if (menu === undefined) return nothing;
    const values = this.checkboxValues;
    const rows = Rec.toEntries(DOCUMENT_TASK_OPTIONS).filter(
      ([, row]) => row.menu === this.config.type,
    );
    return html`
      <wa-dropdown placement="bottom-start" @wa-select=${this.handleMenuSelect}>
        <wa-button
          slot="trigger"
          id=${menu.id}
          class=${classMap({
            'action-icon-button': true,
            'has-options': rows.some(([key]) => values[key]),
          })}
          appearance="plain"
          variant="neutral"
          size="s"
          type="button"
          aria-label=${menu.label}
        >
          ${waIcon(menu.icon)}
        </wa-button>
        ${repeat(
          rows,
          ([key]) => key,
          ([key, row]) => html`
            <wa-dropdown-item
              type="checkbox"
              value=${key}
              ?checked=${values[key]}
            >
              ${row.label}
            </wa-dropdown-item>
          `,
        )}
      </wa-dropdown>
      <wa-tooltip for=${menu.id}>${menu.label}</wa-tooltip>
    `;
  }

  private renderFileList(): TemplateResult {
    if (this.files.length === 0) {
      return html`<div class="file-list-placeholder">
        No files selected. Add or drop files here.
      </div>`;
    }

    const movable = this.files.length > 1;
    return html`<div role="list" aria-label=${`${this.config.label} files`}>
      ${repeat(
        this.files,
        (file) => file,
        (file, index) => {
          const display = this.formatFilePath(file);
          return html`
            <div
              class="file-item"
              role="listitem"
              data-path=${file}
              title=${file}
            >
              <span class="file-name">
                <bdi class="file-name-main" dir="auto">${display.name}</bdi>
                ${
                  display.folder
                    ? html`<span class="file-folder">
                        ${waIcon('folder')}
                        <bdi dir="auto">${display.folder}</bdi>
                      </span>`
                    : nothing
                }
              </span>
              ${
                movable
                  ? html`
                      ${renderIconActionButton({
                        id: `file-select-move-up-${index}`,
                        icon: 'arrow-up',
                        label: `Move ${file} up`,
                        tooltip: `Move up: ${file}`,
                        className: 'move-button',
                        disabled: index === 0,
                        onClick: () => this.moveFile(index, -1),
                      })}
                      ${renderIconActionButton({
                        id: `file-select-move-down-${index}`,
                        icon: 'arrow-down',
                        label: `Move ${file} down`,
                        tooltip: `Move down: ${file}`,
                        className: 'move-button',
                        disabled: index === this.files.length - 1,
                        onClick: () => this.moveFile(index, 1),
                      })}
                    `
                  : nothing
              }
              ${renderIconActionButton({
                id: `file-select-remove-${index}`,
                icon: 'trash',
                label: `Remove ${file}`,
                tooltip: `Remove: ${file}`,
                className: 'remove-button',
                onClick: () => this.removeFile(file),
              })}
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
    const typeLabel = Str.capitalize(config.type);
    const labelId = `${this.listId}Label`;

    return html`
      <div
        class=${classMap({
          'file-select': true,
          'drop-active': this.fileDrop.isDragActive,
        })}
        role="group"
        aria-labelledby=${labelId}
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
            <span id=${labelId} class="file-select-label">${config.label}</span>
            <span class="file-select-count" role="status" aria-atomic="true">
              ${
                this.files.length === 0
                  ? nothing
                  : formatResultCount(this.files.length, 'file')
              }
            </span>
            ${this.renderConfigMenu()}
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
              disabled: this.files.length === 0,
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
        ${
          this.fileDrop.isDragActive
            ? html`<div class="drop-cue" aria-hidden="true">
                Drop ${config.label.toLowerCase()} files here
              </div>`
            : nothing
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'file-select-group': FileSelectGroup;
  }
}
