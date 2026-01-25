// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - progress view constants
import { COMMANDS, ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';

// Local imports - shared schemas
import type { OutputFileInfo } from '@shared/schemas';

/** Parsed path components for display */
interface ParsedPath {
  dir: string;
  basename: string;
  normalized: string;
}

/** Parse a path into directory and basename components */
function parsePath(path: string): ParsedPath {
  const normalized = path.replaceAll('\\', '/');
  const lastSlash = normalized.lastIndexOf('/');
  return {
    dir: lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : '',
    basename: lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized,
    normalized,
  };
}

@customElement('file-list')
export class FileList extends LitElement {
  @property({ type: Object }) filesByRound: Record<string, OutputFileInfo[]> =
    {};
  @property({ type: Boolean }) showRoundHeaders = true;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult | typeof nothing {
    const rounds = this.getSortedRounds();
    if (rounds.length === 0) {
      return nothing;
    }

    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.GENERATED_FILES_COLLAPSIBLE}
        class="files-collapsible progress-collapsible"
        title="Generated Files"
        open
      >
        <div
          id=${ELEMENT_IDS.GENERATED_FILES}
          class="files-container"
          @click=${this.handleFileClick}
        >
          ${repeat(
            rounds,
            ([round]) => round,
            ([round, files]) => this.renderRound(round, files),
          )}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderRound(round: number, files: OutputFileInfo[]): TemplateResult {
    if (!this.showRoundHeaders) {
      return html`${files.map((file) => this.renderFileItem(file))}`;
    }

    return html`
      <vscode-collapsible
        class="round-collapsible progress-collapsible"
        title=${`r${round}`}
        ?open=${true}
      >
        <div class="round-content">
          ${files.map((file) => this.renderFileItem(file))}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderFileItem(
    file: OutputFileInfo,
  ): TemplateResult | typeof nothing {
    if (!file?.location) return nothing;

    const location = file.location;
    const displayPath =
      (file.lineage?.original
        ? this.getDisplayPath(file.lineage.original)
        : null) ?? this.getDisplayPath(location);
    const { dir, basename } = parsePath(displayPath);
    const tooltipPath = this.getDisplayPath(location);
    const effectiveBase =
      file.lineage?.diffBase?.absolutePath ??
      file.lineage?.original?.absolutePath ??
      '';
    const diffBase = file.lineage?.diffBase?.absolutePath;

    // Store paths in data attributes for event delegation
    return html`
      <div
        class="file-item"
        data-file=${location.absolutePath}
        data-base=${ifDefined(effectiveBase || undefined)}
        data-prev=${ifDefined(diffBase)}
      >
        <span class="file-name">
          <span
            class="file-path clickable-link"
            title=${tooltipPath}
            data-command=${COMMANDS.OPEN_FILE}
          >
            <span class="file-dir">${dir}</span>
            <span class="file-basename">${basename}</span>
          </span>
        </span>
        ${when(
          file.diff?.added !== undefined,
          () => html`
            <span class="file-stats">
              <span class="added">+${file.diff!.added}</span>
              ${when(
                file.diff!.removed !== undefined,
                () => html`<span class="removed">-${file.diff!.removed}</span>`,
              )}
            </span>
          `,
        )}
        <vscode-toolbar-container class="file-actions">
          ${when(
            effectiveBase,
            () => html`
              <vscode-toolbar-button
                class="compare-btn"
                icon="diff"
                label="Compare with base"
                title="Compare with base"
                data-command=${COMMANDS.COMPARE_ORIGINAL}
              ></vscode-toolbar-button>
              <vscode-toolbar-button
                class="accept-btn"
                icon="check"
                label="Accept edits"
                title="Accept edits"
                data-command=${COMMANDS.ACCEPT_FILE}
              ></vscode-toolbar-button>
              <vscode-toolbar-button
                class="merge-btn"
                icon="git-merge"
                label="Merge edits"
                title="Merge edits"
                data-command=${COMMANDS.MERGE_FILE}
              ></vscode-toolbar-button>
              <vscode-toolbar-button
                class="diff-btn"
                icon="diff-single"
                label="LaTeXdiff"
                title="LaTeXdiff"
                data-command=${COMMANDS.LATEXDIFF_FILE}
              ></vscode-toolbar-button>
            `,
          )}
          ${when(
            diffBase,
            () => html`
              <vscode-toolbar-button
                class="prev-btn"
                icon="diff-added"
                label="Compare with previous round"
                title="Compare with previous round"
                data-command=${COMMANDS.COMPARE_PREVIOUS}
              ></vscode-toolbar-button>
            `,
          )}
        </vscode-toolbar-container>
      </div>
    `;
  }

  /**
   * Event delegation handler for file actions.
   * Uses data-command on clickable elements and data-file/data-base/data-prev on file-item.
   */
  private handleFileClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (!target) return;

    // Find element with data-command
    const actionEl = target.closest('[data-command]') as HTMLElement | null;
    if (!actionEl) return;

    const command = actionEl.dataset.command;
    if (!command) return;

    // Find parent file-item for file paths
    const fileItem = target.closest('.file-item') as HTMLElement | null;
    if (!fileItem) return;

    const file = fileItem.dataset.file;
    if (!file) return;

    // Build payload based on command
    const payload: Record<string, string> = { file };

    if (command === COMMANDS.COMPARE_PREVIOUS) {
      const prev = fileItem.dataset.prev;
      if (prev) payload.prev = prev;
      const base = fileItem.dataset.base;
      if (base) payload.base = base;
    } else if (
      command === COMMANDS.COMPARE_ORIGINAL ||
      command === COMMANDS.ACCEPT_FILE ||
      command === COMMANDS.MERGE_FILE ||
      command === COMMANDS.LATEXDIFF_FILE
    ) {
      const base = fileItem.dataset.base;
      if (base) payload.base = base;
    }

    this.dispatchEvent(ProgressEvents.fileAction({ command, ...payload }));
  };

  private getSortedRounds(): [number, OutputFileInfo[]][] {
    return Object.entries(this.filesByRound)
      .map(
        ([round, files]) =>
          [Number(round), files] as [number, OutputFileInfo[]],
      )
      .filter(
        ([round, files]) =>
          !Number.isNaN(round) && Array.isArray(files) && files.length > 0,
      )
      .sort((a, b) => a[0] - b[0]);
  }

  private getDisplayPath(loc: OutputFileInfo['location']): string {
    if (!loc) return '';
    return loc.kind === 'workspace' || loc.kind === 'runStorage'
      ? loc.relativePath
      : loc.absolutePath;
  }
}
