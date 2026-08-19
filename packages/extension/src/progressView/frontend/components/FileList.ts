// Third-party imports
import {
  LitElement,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  fileLocationDisplayPath,
  getEffectiveDiffBase,
  outputDiffCounts,
  outputDisplayName,
  roundIndexedEntries,
  type CompileFailure,
  type OutputFileInfo,
} from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { formatRoundStageLabel } from '@shared/streams/streamStatusDisplay';
import { UnsupportedCommandsMixin } from '@shared/wa/unsupportedCommandsMixin';
import { isKnownUnsupported } from '@shared/utils/dispatcher';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { normalizeFilePath } from '@utils/core';
import { ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';
import { getComposedPathElement } from '../utils';
import { webviewStorage } from '../webviewStorage';

// Local imports - styles
import { fileListStyles } from './FileList.styles';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

interface FileActionOptions {
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly title: string;
  readonly className: string;
  readonly command: string;
  readonly file: string;
  // Unique per (round, file-index) so the button id can't collide when the
  // same workspace path appears across rounds in one shadow root.
  readonly idPrefix: string;
  readonly base?: string;
  readonly prev?: string;
}

function renderFileActionButton(opts: FileActionOptions): TemplateResult {
  // idPrefix is unique per (round, file-index); command is unique per button
  // within a file, so the pair never collides — even when the same path shows
  // up across rounds in one shadow root. Sanitize to a valid id the
  // <wa-tooltip> anchors to via `for`. These buttons live in a flex
  // `.file-actions` row (not a wa-button-group), so the sibling tooltip is safe.
  const buttonId = `${opts.idPrefix}-${opts.command}`.replaceAll(
    /[^a-zA-Z0-9_-]/g,
    '-',
  );
  return html`
    <wa-button
      id=${buttonId}
      class="action-icon-button ${opts.className}"
      appearance="plain"
      variant="neutral"
      size="s"
      type="button"
      aria-label=${opts.label}
      data-command=${opts.command}
      data-file=${opts.file}
      data-base=${ifDefined(opts.base)}
      data-prev=${ifDefined(opts.prev)}
    >
      ${waIcon(opts.icon)}
    </wa-button>
    <wa-tooltip for=${buttonId}>${opts.title}</wa-tooltip>
  `;
}

const STORAGE_HINT_DISMISS_KEY = 'generatedFilesStorageHint.dismissed';

/** Parsed path components for display */
interface ParsedPath {
  dir: string;
  basename: string;
}

/** Parse a path into directory and basename components */
function parsePath(path: string): ParsedPath {
  const normalized = normalizeFilePath(path);
  // With no slash, lastIndexOf is -1 and both slices already yield the
  // fallbacks: '' for dir, the whole path for basename.
  const lastSlash = normalized.lastIndexOf('/');
  return {
    dir: normalized.slice(0, lastSlash + 1),
    basename: normalized.slice(lastSlash + 1),
  };
}

@customElement('file-list')
export class FileList extends UnsupportedCommandsMixin(LitElement) {
  static override styles = [designTokens, commonViewStyles, fileListStyles];

  @property({ attribute: false }) filesByRound: Record<
    string,
    OutputFileInfo[]
  > = {};
  @property({ attribute: false }) failuresByRound: Record<
    string,
    CompileFailure[]
  > = {};

  @state()
  private storageHintDismissed =
    webviewStorage.get(STORAGE_HINT_DISMISS_KEY) === true;

  // Flattened from failuresByRound to avoid O(rounds) scan per file item in render.
  private failureByPath = new Map<string, CompileFailure>();
  private sortedRounds: [number, OutputFileInfo[]][] = [];

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has('filesByRound')) {
      this.sortedRounds = roundIndexedEntries(this.filesByRound).filter(
        ([, files]) => files.length > 0,
      );
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
        summary="Generated files"
        open
      >
        ${this.renderStorageHint()}
        <div
          id=${ELEMENT_IDS.GENERATED_FILES}
          class="files-container"
          @click=${this.handleFileClick}
          @keydown=${this.handleFileKey}
        >
          ${repeat(
            this.sortedRounds,
            ([round]) => round,
            ([round, files]) => this.renderRound(round, files),
          )}
        </div>
        ${
          this.failureByPath.size > 0 &&
          !isKnownUnsupported(
            this.unsupportedCommands,
            PROGRESS_VIEW_COMMANDS.RUN_COMPILE_FIXER,
          )
            ? html`
                <div class="compile-actions">
                  <wa-button
                    appearance="filled"
                    variant="brand"
                    size="s"
                    @click=${this.runLatexFixer}
                  >
                    ${waIcon('screwdriver-wrench', { slot: 'start' })} Run
                    latexFixer
                  </wa-button>
                </div>
              `
            : nothing
        }
      </wa-details>
    `;
  }

  private renderStorageHint(): TemplateResult | typeof nothing {
    if (this.storageHintDismissed) return nothing;

    return html`
      <div class="storage-hint" role="note">
        ${waIcon('folder-open')}
        <span class="storage-hint__text">
          Files stay in task-run storage until accepted. Click a file to preview
          it, use Accept to copy it into your workspace, or use the folder
          button to open the full run.
        </span>
        ${renderIconActionButton({
          id: 'storage-hint-dismiss-button',
          icon: 'xmark',
          label: 'Dismiss storage explanation',
          tooltip: 'Dismiss storage explanation',
          className: 'storage-hint__dismiss',
          onClick: this.handleDismissStorageHint,
        })}
      </div>
    `;
  }

  private handleDismissStorageHint = (): void => {
    void webviewStorage.update(STORAGE_HINT_DISMISS_KEY, true);
    this.storageHintDismissed = true;
  };

  private renderRound(round: number, files: OutputFileInfo[]): TemplateResult {
    const rows = repeat(
      files,
      (file, index) => `${round}-${file.location?.absolutePath ?? index}`,
      (file, index) => this.renderFileItem(file, round, index),
    );

    // A per-round disclosure only earns its chrome when there are multiple
    // rounds to tell apart; a single round renders its files directly.
    if (this.sortedRounds.length === 1) {
      return html`${rows}`;
    }

    return html`
      <wa-details
        class="round-collapsible panel-collapsible"
        summary=${formatRoundStageLabel({ index: round })}
        open
      >
        ${rows}
      </wa-details>
    `;
  }

  private renderFileItem(
    file: OutputFileInfo,
    round: number,
    fileIndex: number,
  ): TemplateResult | typeof nothing {
    if (!file?.location) return nothing;

    // Unique within this shadow root: round + the file's index in that round.
    const idPrefix = `file-action-r${round}-f${fileIndex}`;

    const location = file.location;
    const { dir, basename } = parsePath(outputDisplayName(file));
    const tooltipPath = fileLocationDisplayPath(location);
    const effectiveBase =
      getEffectiveDiffBase(file.lineage)?.absolutePath ?? '';
    const diffBase = file.lineage?.diffBase?.absolutePath;

    const filePath = location.absolutePath;
    // Compare against the live workspace document (lineage.original) so the
    // diff opens the user's real, editable file rather than the immutable
    // run-storage snapshot. Fall back to the snapshot base when the output IS
    // the workspace file (true in-place overwrite) — diffing it against
    // itself would show nothing.
    const workspaceOriginal = file.lineage?.original?.absolutePath;
    const compareBase =
      workspaceOriginal && workspaceOriginal !== filePath
        ? workspaceOriginal
        : effectiveBase;
    const failure = this.failureByPath.get(`${round}:${filePath}`);
    const diffStats = this.renderDiffStats(file);
    const baseActions = this.renderBaseActions(
      filePath,
      effectiveBase,
      compareBase,
      idPrefix,
    );
    const previousAction = this.renderPreviousAction(
      filePath,
      effectiveBase,
      diffBase,
      idPrefix,
    );

    return html`
      <div class="file-item">
        ${
          failure
            ? html`${waIcon('triangle-exclamation', { id: `${idPrefix}-compile-warning`, className: 'compile-warning', label: 'Compile check failed' })}
                <wa-tooltip for="${idPrefix}-compile-warning"
                  >Compile check failed</wa-tooltip
                >`
            : nothing
        }
        <span class="file-name">
          <span
            id="${idPrefix}-path"
            class="file-path clickable-link"
            data-command=${PROGRESS_VIEW_COMMANDS.OPEN_FILE}
            data-file=${filePath}
            role="button"
            tabindex="0"
          >
            <span class="file-dir">${dir}</span>
            <span class="file-basename">${basename}</span>
          </span>
          <wa-tooltip for="${idPrefix}-path">${tooltipPath}</wa-tooltip>
        </span>
        ${diffStats}
        <div class="file-actions">
          ${
            failure
              ? renderFileActionButton({
                  icon: 'terminal',
                  label: 'Open compile log',
                  title: `Open compile log (${failure.logRelativePath})`,
                  className: '',
                  command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
                  file: failure.log.absolutePath,
                  idPrefix,
                })
              : nothing
          }
          ${baseActions} ${previousAction}
        </div>
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
    this.dispatchFileAction(actionEl);
  }

  // Keyboard activation parity for the clickable file rows (Enter/Space), so
  // the generated-files list is reachable without a mouse — mirrors the click
  // delegation for file-path spans without intercepting native wa-button keys.
  private handleFileKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const actionEl = getComposedPathElement<HTMLElement>(
      event,
      '.file-path[data-command]',
    );
    if (!(actionEl instanceof HTMLElement)) return;
    event.preventDefault();
    this.dispatchFileAction(actionEl);
  }

  private dispatchFileAction(actionEl: HTMLElement): void {
    const { command, file, base, prev } = actionEl.dataset;
    if (!command || !file) return;

    this.dispatchEvent(
      ProgressEvents.fileAction({ command, file, base, prev }),
    );
  }

  private runLatexFixer(): void {
    this.dispatchEvent(ProgressEvents.compileFixerRun());
  }

  private renderDiffStats(
    file: OutputFileInfo,
  ): TemplateResult | typeof nothing {
    const counts = outputDiffCounts(file.diff);
    if (!counts) return nothing;

    return html`
      <span class="file-stats">
        <span class="added">+${counts.added}</span>
        <span class="removed">-${counts.removed}</span>
      </span>
    `;
  }

  private renderBaseActions(
    filePath: string,
    basePath: string,
    compareBase: string,
    idPrefix: string,
  ): TemplateResult | typeof nothing {
    if (!basePath) return nothing;

    return html`
      ${renderFileActionButton({
        icon: 'code-compare',
        label: 'Compare with base',
        title: 'Compare with base in a side-by-side diff',
        className: 'compare-btn',
        command: PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL,
        file: filePath,
        base: compareBase,
        idPrefix,
      })}
      ${renderFileActionButton({
        icon: 'plus-minus',
        label: 'Run latexdiff',
        title: 'Run latexdiff against the base file',
        className: 'latexdiff-btn',
        command: PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE,
        file: filePath,
        base: basePath,
        idPrefix,
      })}
      ${renderFileActionButton({
        icon: 'check',
        label: 'Accept edits',
        title: 'Accept edits into the workspace file',
        className: 'accept-btn',
        command: PROGRESS_VIEW_COMMANDS.ACCEPT_FILE,
        file: filePath,
        base: compareBase,
        idPrefix,
      })}
      ${renderFileActionButton({
        icon: 'code-merge',
        label: 'Merge edits',
        title: 'Merge edits into the workspace file',
        className: 'merge-btn',
        command: PROGRESS_VIEW_COMMANDS.MERGE_FILE,
        file: filePath,
        base: basePath,
        idPrefix,
      })}
    `;
  }

  private renderPreviousAction(
    filePath: string,
    basePath: string,
    previousPath: string | undefined,
    idPrefix: string,
  ): TemplateResult | typeof nothing {
    if (!previousPath || previousPath === basePath) return nothing;

    return renderFileActionButton({
      icon: 'plus',
      label: 'Compare with previous round',
      title: 'Compare with previous round in a side-by-side diff',
      className: 'prev-btn',
      command: PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS,
      file: filePath,
      base: basePath,
      prev: previousPath,
      idPrefix,
    });
  }
}
