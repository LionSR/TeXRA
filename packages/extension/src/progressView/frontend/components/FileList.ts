// Third-party imports
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import type { CompileFailure, OutputFileInfo } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';
import { ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';
import { getComposedPathElement } from '../utils';
import { webviewStorage } from '../webviewStorage';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

const STORAGE_HINT_DISMISS_KEY = 'generatedFilesStorageHint.dismissed';

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
  static override styles = [
    designTokens,
    codiconIconClasses,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .files-container {
        padding: 0;
        font-size: var(--texra-editor-font-size);
        overflow-y: auto;
        max-height: var(--height-large);
        flex-shrink: 0;
      }

      .storage-hint {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) 0 var(--spacing-small);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        line-height: 1.4;
      }

      .storage-hint .codicon {
        flex-shrink: 0;
      }

      .storage-hint__text {
        flex: 1;
        min-width: 0;
      }

      .storage-hint__dismiss {
        flex-shrink: 0;
        color: var(--color-text-secondary);
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
        font-weight: var(--font-weight-medium);
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
        color: var(--texra-charts-green, green);
        margin-left: var(--spacing-small);
        font-size: var(--font-size-sm);
      }

      .removed {
        color: var(--texra-charts-red, red);
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

      /* Nested round collapsibles */
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

      .compile-warning {
        flex-shrink: 0;
        color: var(--texra-editorWarning-foreground, orange);
      }

      .compile-actions {
        display: flex;
        justify-content: flex-end;
        padding: var(--spacing-small) 0;
        border-top: var(--border-thin) solid var(--color-border);
        margin-top: var(--spacing-tiny);
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
    `,
  ];

  @property({ attribute: false }) filesByRound: Record<
    string,
    OutputFileInfo[]
  > = {};
  @property({ attribute: false }) failuresByRound: Record<
    string,
    CompileFailure[]
  > = {};
  @property({ attribute: false }) showRoundHeaders = true;

  @state()
  private storageHintDismissed =
    webviewStorage.get(STORAGE_HINT_DISMISS_KEY) === true;

  // Flattened from failuresByRound to avoid O(rounds) scan per file item in render.
  private failureByPath = new Map<string, CompileFailure>();
  private sortedRounds: [number, OutputFileInfo[]][] = [];

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has('filesByRound')) {
      this.sortedRounds = Object.entries(this.filesByRound)
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
    if (changedProperties.has('failuresByRound')) {
      this.failureByPath = new Map();
      for (const [roundStr, failures] of Object.entries(this.failuresByRound)) {
        const round = Number(roundStr);
        for (const f of failures) {
          this.failureByPath.set(`${round}:${f.output.absolutePath}`, f);
        }
      }
    }
  }

  override render(): TemplateResult | typeof nothing {
    if (this.sortedRounds.length === 0) {
      return nothing;
    }

    return html`
      <wa-details
        id=${ELEMENT_IDS.GENERATED_FILES_COLLAPSIBLE}
        class="panel-collapsible"
        summary="Generated Files"
        open
      >
        ${this.renderStorageHint()}
        <div
          id=${ELEMENT_IDS.GENERATED_FILES}
          class="files-container"
          @click=${this.handleFileClick}
        >
          ${repeat(
            this.sortedRounds,
            ([round]) => round,
            ([round, files]) => this.renderRound(round, files),
          )}
        </div>
        ${this.failureByPath.size > 0
          ? html`
              <div class="compile-actions">
                <vscode-button
                  appearance="primary"
                  @click=${this.runLatexFixer}
                >
                  <span slot="start" class="codicon codicon-tools"></span>
                  Run latexFixer
                </vscode-button>
              </div>
            `
          : nothing}
      </wa-details>
    `;
  }

  private renderStorageHint(): TemplateResult | typeof nothing {
    if (this.storageHintDismissed) return nothing;

    return html`
      <div class="storage-hint" role="note">
        <i class="codicon codicon-folder-opened" aria-hidden="true"></i>
        <span class="storage-hint__text">
          Files stay in task-run storage until accepted. Click a file to preview
          it, use Accept to copy it into your workspace, or use the folder
          button to open the full run.
        </span>
        <vscode-toolbar-button
          class="storage-hint__dismiss"
          icon="close"
          label="Dismiss storage explanation"
          title="Dismiss storage explanation"
          @click=${this.handleDismissStorageHint}
        ></vscode-toolbar-button>
      </div>
    `;
  }

  private handleDismissStorageHint = (): void => {
    webviewStorage.set(STORAGE_HINT_DISMISS_KEY, true);
    this.storageHintDismissed = true;
  };

  private renderRound(round: number, files: OutputFileInfo[]): TemplateResult {
    if (!this.showRoundHeaders) {
      return html`${repeat(
        files,
        (file, index) => `${round}-${file.location?.absolutePath ?? index}`,
        (file) => this.renderFileItem(file, round),
      )}`;
    }

    return html`
      <wa-details
        class="round-collapsible panel-collapsible"
        summary=${`r${round}`}
        ?open=${true}
      >
        <div class="round-content">
          ${repeat(
            files,
            (file, index) => `${round}-${file.location?.absolutePath ?? index}`,
            (file) => this.renderFileItem(file, round),
          )}
        </div>
      </wa-details>
    `;
  }

  private renderFileItem(
    file: OutputFileInfo,
    round: number,
  ): TemplateResult | typeof nothing {
    if (!file?.location) return nothing;

    const location = file.location;
    // Prefer: workspace original → source doc name → run-storage relative path
    const displayPath =
      this.getDisplayPath(file.lineage?.original) ||
      this.getSourceDisplayPath(file.source) ||
      this.getDisplayPath(location);
    const { dir, basename } = parsePath(displayPath);
    const tooltipPath = this.getDisplayPath(location);
    const effectiveBase =
      file.lineage?.diffBase?.absolutePath ??
      file.lineage?.original?.absolutePath ??
      '';
    const diffBase = file.lineage?.diffBase?.absolutePath;

    const filePath = location.absolutePath;
    const failure = this.failureByPath.get(`${round}:${filePath}`);
    const diffStats = this.renderDiffStats(file);
    const baseActions = this.renderBaseActions(filePath, effectiveBase);
    const previousAction = this.renderPreviousAction(
      filePath,
      effectiveBase,
      diffBase,
    );

    return html`
      <div class="file-item">
        ${failure
          ? html`<i
              class="codicon codicon-warning compile-warning"
              title="Compile check failed"
              aria-label="Compile check failed"
            ></i>`
          : nothing}
        <span class="file-name">
          <span
            class="file-path clickable-link"
            title=${tooltipPath}
            data-command=${PROGRESS_VIEW_COMMANDS.OPEN_FILE}
            data-file=${filePath}
          >
            <span class="file-dir">${dir}</span>
            <span class="file-basename">${basename}</span>
          </span>
        </span>
        ${diffStats}
        <vscode-toolbar-container class="file-actions">
          ${failure
            ? html`<vscode-toolbar-button
                icon="output"
                label="Open compile log"
                title="Open compile log (${failure.logRelativePath})"
                data-command=${PROGRESS_VIEW_COMMANDS.OPEN_FILE}
                data-file=${failure.log.absolutePath}
              ></vscode-toolbar-button>`
            : nothing}
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
    const actionEl = getComposedPathElement<HTMLElement>(
      event,
      '[data-command]',
    );
    if (!(actionEl instanceof HTMLElement)) return;

    const { command, file, base, prev } = actionEl.dataset;
    if (!command || !file) return;

    this.dispatchEvent(
      ProgressEvents.fileAction({ command, file, base, prev }),
    );
  }

  private runLatexFixer(): void {
    this.dispatchEvent(ProgressEvents.compileFixerRun());
  }

  private getDisplayPath(
    loc: OutputFileInfo['location'] | null | undefined,
  ): string {
    if (!loc) return '';
    return loc.kind === 'workspace' || loc.kind === 'runStorage'
      ? loc.relativePath
      : loc.absolutePath;
  }

  /**
   * Derive a display path from the source document name when lineage.original
   * is absent (e.g. multi-doc extractions whose names don't match a base file).
   * Returns empty string for generic names that shouldn't override the fallback.
   */
  private getSourceDisplayPath(source: string | undefined): string {
    if (
      !source ||
      source === 'output' ||
      source === 'output.xml' ||
      source === 'output.tex'
    )
      return '';
    // Treat a trailing all-alpha suffix as a real extension (.tex, .txt, .bib…).
    // Suffixes containing digits (.v2, .r3) are version qualifiers, not
    // extensions, so .tex is appended in those cases.
    const hasExt = /\.[a-zA-Z]+$/.test(source);
    return hasExt ? source : `${source}.tex`;
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
        data-command=${PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL}
        data-file=${filePath}
        data-base=${basePath}
      ></vscode-toolbar-button>
      <vscode-toolbar-button
        class="accept-btn"
        icon="check"
        label="Accept edits"
        title="Accept edits"
        data-command=${PROGRESS_VIEW_COMMANDS.ACCEPT_FILE}
        data-file=${filePath}
        data-base=${basePath}
      ></vscode-toolbar-button>
      <vscode-toolbar-button
        class="merge-btn"
        icon="git-merge"
        label="Merge edits"
        title="Merge edits"
        data-command=${PROGRESS_VIEW_COMMANDS.MERGE_FILE}
        data-file=${filePath}
        data-base=${basePath}
      ></vscode-toolbar-button>
      <vscode-toolbar-button
        class="diff-btn"
        icon="diff-single"
        label="LaTeXdiff"
        title="LaTeXdiff"
        data-command=${PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE}
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
        data-command=${PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS}
        data-file=${filePath}
        data-base=${basePath}
        data-prev=${previousPath}
      ></vscode-toolbar-button>
    `;
  }
}
