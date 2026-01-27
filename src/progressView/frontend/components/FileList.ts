// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

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
  static override styles = css`
    :host {
      display: block;
    }

    :host([hidden]) {
      display: none;
    }

    .files-collapsible {
      margin: 0;
      border-top: var(--border-thin) solid var(--color-border);
    }

    .files-collapsible::part(header) {
      padding: var(--spacing-tiny) var(--spacing-medium);
      background-color: var(
        --vscode-sideBarSectionHeader-background,
        transparent
      );
      color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
    }

    .files-collapsible::part(body) {
      padding: 0 var(--spacing-small) var(--spacing-tiny);
    }

    .files-container {
      padding: 0;
      font-size: var(--vscode-editor-font-size);
      overflow-y: auto;
      max-height: var(--height-large);
      flex-shrink: 0;
    }

    .file-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-tiny);
      padding: var(--spacing-tiny) 0;
      margin-bottom: 0;
    }

    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 200px;
    }

    .clickable-link {
      cursor: pointer;
      color: var(--color-text-link);
      text-decoration: none;
    }

    .clickable-link:hover {
      color: var(--color-text-link-active);
      text-decoration: underline;
    }

    .file-path {
      cursor: pointer;
    }

    .file-path:hover {
      text-decoration: underline;
    }

    .file-dir {
      opacity: var(--opacity-subtle);
      font-size: var(--font-size-sm);
    }

    .file-basename {
      font-weight: 500;
    }

    .file-stats {
      white-space: nowrap;
      text-decoration: none;
      flex-shrink: 0;
      font-size: var(--font-size-sm);
      color: var(--color-text-secondary);
    }

    .file-stats span:first-child {
      margin-left: 0;
    }

    .added {
      color: var(--vscode-charts-green, green);
      margin-left: var(--spacing-small);
      font-size: var(--font-size-sm);
    }

    .removed {
      color: var(--vscode-charts-red, red);
      margin-left: var(--spacing-small);
      font-size: var(--font-size-sm);
    }

    .file-actions {
      display: flex;
      gap: var(--spacing-tiny);
      flex-shrink: 0;
      flex-wrap: nowrap;
      align-items: center;
    }

    .file-actions :is(vscode-button, vscode-toolbar-button) {
      margin-right: 0;
      margin-left: var(--spacing-tiny);
    }

    .round-collapsible {
      border-top: var(--border-thin) solid var(--color-border);
    }

    .round-collapsible:first-child {
      border-top: none;
    }

    .round-collapsible::part(header) {
      padding: var(--spacing-tiny) 0;
      font-size: var(--font-size-sm);
    }

    .round-collapsible::part(body) {
      padding: 0;
    }

    @media (max-width: 500px) {
      .file-item {
        flex-wrap: wrap;
        gap: var(--spacing-small);
        align-items: center;
      }

      .file-name {
        width: 100%;
        flex-basis: 100%;
      }

      .file-actions {
        margin-left: auto;
      }
    }
  `;

  @property({ type: Object }) filesByRound: Record<string, OutputFileInfo[]> =
    {};
  @property({ type: Boolean }) showRoundHeaders = true;

  override render(): TemplateResult | typeof nothing {
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
      return html`${repeat(
        files,
        (file) => file.location?.absolutePath ?? '',
        (file) => this.renderFileItem(file),
      )}`;
    }

    return html`
      <vscode-collapsible
        class="round-collapsible progress-collapsible"
        title=${`r${round}`}
        ?open=${true}
      >
        <div class="round-content">
          ${repeat(
            files,
            (file) => file.location?.absolutePath ?? '',
            (file) => this.renderFileItem(file),
          )}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderFileItem(
    file: OutputFileInfo,
  ): TemplateResult | typeof nothing {
    if (!file?.location) return nothing;

    const location = file.location;
    const displayPath = this.getDisplayPath(file.lineage?.original ?? location);
    const { dir, basename } = parsePath(displayPath);
    const tooltipPath = this.getDisplayPath(location);
    const effectiveBase =
      file.lineage?.diffBase?.absolutePath ??
      file.lineage?.original?.absolutePath ??
      '';
    const diffBase = file.lineage?.diffBase?.absolutePath;

    const filePath = location.absolutePath;
    const diffStats = this.renderDiffStats(file);
    const baseActions = this.renderBaseActions(filePath, effectiveBase);
    const previousAction = this.renderPreviousAction(
      filePath,
      effectiveBase,
      diffBase,
    );

    return html`
      <div class="file-item">
        <span class="file-name">
          <span
            class="file-path clickable-link"
            title=${tooltipPath}
            data-command=${COMMANDS.OPEN_FILE}
            data-file=${filePath}
          >
            <span class="file-dir">${dir}</span>
            <span class="file-basename">${basename}</span>
          </span>
        </span>
        ${diffStats}
        <vscode-toolbar-container class="file-actions">
          ${baseActions} ${previousAction}
        </vscode-toolbar-container>
      </div>
    `;
  }

  /**
   * Event delegation handler for file actions.
   * All data is stored directly on command elements for unified delegation.
   */
  private handleFileClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    if (!target) return;

    // Find element with data-command (all needed data is on this element)
    const actionEl = target.closest('[data-command]');
    if (!(actionEl instanceof HTMLElement)) return;

    const { command, file, base, prev } = actionEl.dataset;
    if (!command || !file) return;

    // Build payload - include base/prev only if present
    const payload: Record<string, string> = { file };
    if (base) payload.base = base;
    if (prev) payload.prev = prev;

    this.dispatchEvent(ProgressEvents.fileAction({ command, ...payload }));
  }

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

  private renderDiffStats(
    file: OutputFileInfo,
  ): TemplateResult | typeof nothing {
    const diff = file.diff;
    if (!diff || diff.added === undefined) {
      return nothing;
    }

    const removed =
      diff.removed !== undefined
        ? html`<span class="removed">-${diff.removed}</span>`
        : nothing;

    return html`
      <span class="file-stats">
        <span class="added">+${diff.added}</span>
        ${removed}
      </span>
    `;
  }

  private renderBaseActions(
    filePath: string,
    basePath: string,
  ): TemplateResult | typeof nothing {
    if (!basePath) return nothing;

    return html`
      <vscode-toolbar-button
        class="compare-btn"
        icon="diff"
        label="Compare with base"
        title="Compare with base"
        data-command=${COMMANDS.COMPARE_ORIGINAL}
        data-file=${filePath}
        data-base=${basePath}
      ></vscode-toolbar-button>
      <vscode-toolbar-button
        class="accept-btn"
        icon="check"
        label="Accept edits"
        title="Accept edits"
        data-command=${COMMANDS.ACCEPT_FILE}
        data-file=${filePath}
        data-base=${basePath}
      ></vscode-toolbar-button>
      <vscode-toolbar-button
        class="merge-btn"
        icon="git-merge"
        label="Merge edits"
        title="Merge edits"
        data-command=${COMMANDS.MERGE_FILE}
        data-file=${filePath}
        data-base=${basePath}
      ></vscode-toolbar-button>
      <vscode-toolbar-button
        class="diff-btn"
        icon="diff-single"
        label="LaTeXdiff"
        title="LaTeXdiff"
        data-command=${COMMANDS.LATEXDIFF_FILE}
        data-file=${filePath}
        data-base=${basePath}
      ></vscode-toolbar-button>
    `;
  }

  private renderPreviousAction(
    filePath: string,
    basePath: string,
    previousPath: string | undefined,
  ): TemplateResult | typeof nothing {
    if (!previousPath) return nothing;

    return html`
      <vscode-toolbar-button
        class="prev-btn"
        icon="diff-added"
        label="Compare with previous round"
        title="Compare with previous round"
        data-command=${COMMANDS.COMPARE_PREVIOUS}
        data-file=${filePath}
        data-base=${basePath}
        data-prev=${previousPath}
      ></vscode-toolbar-button>
    `;
  }
}
