/** Collapsible latexdiff comparison results panel. */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { ifDefined } from 'lit/directives/if-defined.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import type { DiffResultDisplay, DiffStatus } from '@shared/schemas';
import { formatRoundStageLabel } from '@shared/streams/streamStatusDisplay';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - progress view events
import { ProgressEvents } from '../events';

// Local imports - progress view helpers
import { buildDetailsSummary } from '../formatters/htmlBuilders';

// Local imports - styles
import { bannerDetailsWaDetailsStyles } from '../styles/logEntryStyles';

/** Status wa-icon name lookup for latexdiff entries. */
const LATEXDIFF_STATUS_ICONS: Record<DiffStatus, TeXRAIconName> = {
  success: 'check',
  error: 'circle-exclamation',
};

/** Screen-reader labels for the otherwise icon-only result status. */
const LATEXDIFF_STATUS_LABELS: Record<DiffStatus, string> = {
  success: 'Comparison succeeded',
  error: 'Comparison failed',
};

@customElement('latexdiff-results')
export class LatexdiffResults extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    bannerDetailsWaDetailsStyles,
    css`
      :host {
        display: block;
      }

      wa-details {
        margin: var(--wa-space-2xs) 0;
      }

      .latexdiff-content {
        list-style: none;
        margin: 0;
        padding-block: var(--wa-space-3xs) var(--wa-space-2xs);
        padding-inline: var(--wa-space-s) 0;
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
      }

      /* .detail-item base styles are in commonViewStyles */
      .detail-item {
        flex-wrap: wrap;
      }

      .file-link {
        appearance: none;
        padding: 0;
        border: 0;
        background: none;
        color: var(--color-text-link);
        cursor: pointer;
        font: inherit;
        text-align: inherit;
        text-decoration: underline;
        text-decoration-thickness: from-font;
        text-underline-position: from-font;
        overflow-wrap: anywhere;
      }

      .file-link:hover {
        text-decoration: underline;
      }

      .arrow {
        flex-shrink: 0;
      }
    `,
  ];

  /** Log ID for tracking */
  @property({ attribute: false }) logId = '';

  /** Run ID for tracking */
  @property({ attribute: false }) runId = '';

  /** Diff result entries to display */
  @property({ attribute: false }) entries: DiffResultDisplay[] = [];

  private handleFileClick(filePath: string): void {
    this.dispatchEvent(ProgressEvents.fileClick({ file: filePath }));
  }

  private renderFileLink(
    filePath: string,
    label: string,
    accessibleLabel: string,
  ): TemplateResult {
    if (!filePath) {
      return html`<span>${label}</span>`;
    }
    return html`<button
      type="button"
      class="file-link"
      data-file=${filePath}
      aria-label=${accessibleLabel}
      @click=${() => this.handleFileClick(filePath)}
    >
      ${label}
    </button>`;
  }

  private renderEntry(entry: DiffResultDisplay, index: number): TemplateResult {
    const {
      baseFile,
      revisedFile,
      diffFile,
      displayName,
      baseRound,
      revisedRound,
      status,
      message,
      runId,
    } = entry;

    const icon = LATEXDIFF_STATUS_ICONS[status];
    const statusLabel = LATEXDIFF_STATUS_LABELS[status];
    const baseLabel =
      baseRound === null
        ? displayName
        : `${displayName} [${formatRoundStageLabel({ index: baseRound })}]`;
    const revisedLabel = `[${formatRoundStageLabel({ index: revisedRound })}]`;

    const entryId = `latexdiff-entry-${index}`;
    return html`
      <li id=${entryId} class="detail-item" data-run-id=${ifDefined(runId)}>
        ${waIcon(icon, { label: statusLabel })}
        ${this.renderFileLink(baseFile, baseLabel, `Open base file: ${baseLabel}`)}
        ${waIcon('arrow-right', { className: 'arrow' })}
        ${this.renderFileLink(
          revisedFile,
          revisedLabel,
          `Open revised file ${revisedLabel} for ${displayName}`,
        )}
        (${this.renderFileLink(diffFile, 'diff', `Open ${displayName} diff`)})
        ${message ? html`<wa-tooltip for=${entryId}>${message}</wa-tooltip>` : nothing}
      </li>
    `;
  }

  override render(): TemplateResult | typeof nothing {
    if (this.entries.length === 0) {
      return nothing;
    }

    const summaryText =
      this.entries.length === 1
        ? 'Latexdiff result'
        : `Latexdiff results (${this.entries.length})`;

    return html`
      <wa-details
        class="banner-details"
        appearance="plain"
        open
        data-log-id=${ifDefined(this.logId || undefined)}
        data-run-id=${ifDefined(this.runId || undefined)}
      >
        ${buildDetailsSummary({
          iconName: 'code-compare',
          label: summaryText,
        })}
        <ul class="latexdiff-content">
          ${repeat(
            this.entries,
            (entry, index) =>
              `${entry.baseFile}-${entry.revisedFile}-${entry.baseRound ?? 'base'}-${entry.revisedRound ?? 'rev'}-${index}`,
            (entry, index) => this.renderEntry(entry, index),
          )}
        </ul>
      </wa-details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'latexdiff-results': LatexdiffResults;
  }
}
