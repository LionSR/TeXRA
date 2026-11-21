// Third-party imports
import {
  getBasename,
  normalizeFilePath,
  fileLocationDisplayPath,
  type RunId,
} from '@texra-ai/harness/schemas';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports
import {
  type CompileFailure,
  compileFailuresOf,
  outputDiffCounts,
  outputDisplayName,
  formatRoundLabel,
  OUTPUT_DOCUMENTS_TAG,
  type OutputFileInfo,
  type RoundOutput,
  roundAlerts,
} from '@texra/shared/plugins/documentOutputs';
import type { FileActionSchema } from '@texra/shared/session/hostRequest';
import type { Surface } from '@texra/shared/session/surface';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { GENERATED_FILES_LABEL, ROUND_ALERT } from '@ui/copy/documentOutputs';
import { statusGlyph, type StatusLook } from '@ui/copy/runStatus';
import { designTokens, commonViewStyles } from '@ui/styles';
import { toneStyles } from '@ui/styles/toneStyles';
import { lineChangeStatsStyles } from '@ui/styles/surfaceStyles';
import {
  renderIconActionButton,
  renderLabeledActionButton,
  type IconActionButtonOptions,
} from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { buildLineChangeStats } from '@ui/progress/formatters/htmlBuilders';
import { delegateKeyActivation, getComposedPathElement } from './composedPath';

// Local imports - styles
import { fileListStyles } from './FileList.styles';

import './LatexdiffResults';

/**
 * One icon button in a file's toolbar. The id is unique within the shadow
 * root (round, file index, verb), even when one path shows up in several
 * rounds, and sanitized so the tooltip can anchor to it with `for`.
 */
function fileActionButton(
  idPrefix: string,
  verb: string,
  options: Omit<IconActionButtonOptions, 'id'> & { readonly tooltip: string },
): TemplateResult {
  const id = `${idPrefix}-${verb}`.replaceAll(/[^a-zA-Z0-9_-]/g, '-');
  return renderIconActionButton({ ...options, id });
}

/** A round alert's glyph, in its tone. */
function alertIcon(
  alert: StatusLook,
  options: { readonly id?: string; readonly label?: string } = {},
): TemplateResult {
  return waIcon(statusGlyph(alert), {
    ...options,
    className: `round-alert tone-${alert.tone}`,
  });
}

/** A file name that opens the file it names. */
const OPEN_FILE_TARGET = '.file-path[data-file]';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

/** Parse a path into directory and basename components */
function parsePath(path: string): { dir: string; basename: string } {
  const normalized = normalizeFilePath(path);
  // With no slash, lastIndexOf is -1 and the dir slice already yields the
  // fallback: '' for dir.
  const lastSlash = normalized.lastIndexOf('/');
  return {
    dir: normalized.slice(0, lastSlash + 1),
    basename: getBasename(normalized),
  };
}

@customElement('file-list')
export class FileList extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    lineChangeStatsStyles,
    toneStyles,
    fileListStyles,
  ];

  /** The run whose files these are; every verb names it. */
  @property({ attribute: false }) runId: RunId | null = null;

  /** The run's rounds, in order, as its documents fact records them. */
  @property({ attribute: false }) rounds: readonly RoundOutput[] = [];

  /** The surface owns the hint's dismissal. */
  @property({ attribute: false }) surface: Surface | null = null;

  override render(): TemplateResult | typeof nothing {
    if (this.rounds.length === 0) {
      return nothing;
    }

    return html`
      <wa-details
        class="panel-collapsible"
        summary=${GENERATED_FILES_LABEL}
        open
      >
        ${this.renderStorageHint()}
        <div
          class="files-container"
          @click=${this.handleFileClick}
          @keydown=${this.handleFileKey}
        >
          ${repeat(
            this.rounds,
            (round) => round.round,
            (round) => this.renderRound(round),
          )}
        </div>
        ${
          this.rounds.some((round) => compileFailuresOf(round).length > 0)
            ? html`
                <div class="compile-actions">
                  ${renderLabeledActionButton({
                    icon: 'screwdriver-wrench',
                    text: 'Fix compile errors',
                    kind: 'primary',
                    onClick: () => this.runLatexFixer(),
                  })}
                </div>
              `
            : nothing
        }
      </wa-details>
    `;
  }

  private renderStorageHint(): TemplateResult | typeof nothing {
    if (this.surface?.storageHintDismissed) return nothing;

    return html`
      <div class="storage-hint" role="note">
        ${waIcon('folder-open')}
        <span class="storage-hint__text">
          Files stay in run storage until accepted. Click a file to preview it,
          use Accept to copy it into your workspace, or use the folder button to
          open the full run.
        </span>
        ${renderIconActionButton({
          id: 'storage-hint-dismiss-button',
          icon: 'xmark',
          label: 'Dismiss generated files explanation',
          tooltip: 'Dismiss generated files explanation',
          className: 'storage-hint__dismiss',
          onClick: this.handleDismissStorageHint,
        })}
      </div>
    `;
  }

  private handleDismissStorageHint = (): void => {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'dismissStorageHint' }));
  };

  private renderRound(record: RoundOutput): TemplateResult {
    const {
      round,
      outputs: files,
      missingOutputs: missing,
      latexdiffs,
    } = record;
    const failures = compileFailuresOf(record);
    const { noDocuments, replyToCheck } = roundAlerts(record);
    const rows = html`
      <ul class="file-round-list">
        ${repeat(
          files,
          (file) => `${round}-${file.location.absolutePath}`,
          (file, index) =>
            this.renderFileItem(
              file,
              round,
              index,
              failures.find(
                (f) => f.output.absolutePath === file.location.absolutePath,
              ),
            ),
        )}
        ${noDocuments ? html`<li class="file-item">${alertIcon(ROUND_ALERT.noDocuments)} ${ROUND_ALERT.noDocuments.text}</li>` : nothing}
        ${missing.map((name) => html`<li class="file-item">${alertIcon(ROUND_ALERT.missingOutput)} ${ROUND_ALERT.missingOutput.text}: <bdi dir="auto">${name}</bdi></li>`)}
        ${
          replyToCheck
            ? html`<li class="file-item">
                ${waIcon('file-code')}
                <span
                  class="file-path clickable-link"
                  data-file=${replyToCheck.absolutePath}
                  role="button"
                  tabindex="0"
                  >Open the reply</span
                >
                to check its
                <code dir="ltr">&lt;${OUTPUT_DOCUMENTS_TAG}&gt;</code> block
              </li>`
            : nothing
        }
      </ul>
      ${latexdiffs.length > 0 ? html`<latexdiff-results .round=${round} .entries=${latexdiffs}></latexdiff-results>` : nothing}
    `;

    // A per-round disclosure only earns its chrome when there are multiple
    // rounds to tell apart; a single round renders its files directly.
    if (this.rounds.length === 1) {
      return rows;
    }

    return html`
      <wa-details
        class="round-collapsible panel-collapsible"
        summary=${formatRoundLabel(round)}
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
    failure: CompileFailure | undefined,
  ): TemplateResult {
    // Unique within this shadow root: round + the file's index in that round.
    const idPrefix = `file-action-r${round}-f${fileIndex}`;

    const location = file.location;
    const { dir, basename } = parsePath(outputDisplayName(file));
    const tooltipPath = fileLocationDisplayPath(location);
    const filePath = location.absolutePath;
    const diffStats = this.renderDiffStats(file);
    // The verbs over an output and what it revises; the host picks which
    // file each takes as its base.
    const baseActions =
      file.lineage === null
        ? nothing
        : this.renderBaseActions(filePath, tooltipPath, idPrefix);

    return html`
      <li class="file-item">
        ${
          failure
            ? html`${alertIcon(ROUND_ALERT.compileFailed, { id: `${idPrefix}-compile-alert`, label: ROUND_ALERT.compileFailed.text })}
                <wa-tooltip for="${idPrefix}-compile-alert"
                  >${ROUND_ALERT.compileFailed.text}</wa-tooltip
                >`
            : nothing
        }
        <span class="file-name">
          <span
            id="${idPrefix}-path"
            class="file-path clickable-link"
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
              ? fileActionButton(idPrefix, 'openFile', {
                  icon: 'terminal',
                  label: `Open compile log for ${tooltipPath}`,
                  tooltip: `Open compile log (${failure.logRelativePath})`,
                  onClick: () => this.openFile(failure.log.absolutePath),
                })
              : nothing
          }
          ${baseActions}
        </div>
      </li>
    `;
  }

  /** A click on a file name opens it; its buttons carry their own handlers. */
  private handleFileClick(event: MouseEvent): void {
    const pathEl = getComposedPathElement(event, OPEN_FILE_TARGET, HTMLElement);
    if (pathEl?.dataset.file) this.openFile(pathEl.dataset.file);
  }

  // Keyboard activation parity for the clickable file names (Enter/Space), so
  // the generated-files list is reachable without a mouse.
  private handleFileKey(event: KeyboardEvent): void {
    delegateKeyActivation(event, OPEN_FILE_TARGET, (pathEl) => {
      if (pathEl.dataset.file) this.openFile(pathEl.dataset.file);
    });
  }

  private openFile(path: string): void {
    if (this.runId === null) return;
    this.dispatchEvent(SessionUiEvents.host({ kind: 'openFile', path }));
  }

  private fileAction(action: typeof FileActionSchema.Type, file: string): void {
    const runId = this.runId;
    if (runId === null) return;
    this.dispatchEvent(
      SessionUiEvents.host({
        kind: 'fileAction',
        action,
        file,
        base: { kind: 'runOutput', runId },
      }),
    );
  }

  private runLatexFixer(): void {
    if (this.runId === null) return;
    this.dispatchEvent(
      SessionUiEvents.host({
        kind: 'runCompileFixer',
        runId: this.runId,
      }),
    );
  }

  private renderDiffStats(
    file: OutputFileInfo,
  ): TemplateResult | typeof nothing {
    const counts = outputDiffCounts(file.diff);
    if (!counts) return nothing;

    return buildLineChangeStats(counts);
  }

  private renderBaseActions(
    filePath: string,
    displayPath: string,
    idPrefix: string,
  ): TemplateResult {
    const act = (action: typeof FileActionSchema.Type) => () =>
      this.fileAction(action, filePath);
    return html`
      ${fileActionButton(idPrefix, 'compare', {
        icon: 'code-compare',
        label: `Compare ${displayPath} with base`,
        tooltip: 'Compare with base in a side-by-side diff',
        onClick: act('compare'),
      })}
      ${fileActionButton(idPrefix, 'latexdiff', {
        icon: 'plus-minus',
        label: `Run latexdiff for ${displayPath}`,
        tooltip: 'Run latexdiff against the base file',
        onClick: act('latexdiff'),
      })}
      ${fileActionButton(idPrefix, 'accept', {
        icon: 'check',
        label: `Accept edits for ${displayPath}`,
        tooltip: 'Accept edits into the workspace file',
        onClick: act('accept'),
      })}
      ${fileActionButton(idPrefix, 'merge', {
        icon: 'code-merge',
        label: `Merge edits for ${displayPath}`,
        tooltip: 'Merge edits into the workspace file',
        onClick: act('merge'),
      })}
    `;
  }
}
