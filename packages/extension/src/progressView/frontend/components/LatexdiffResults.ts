/** Collapsible latexdiff comparison results panel. */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import type { TeXRAIconName } from '@shared/iconNames';
import { SessionUiEvents } from '@texra/shared/session/uiEvents';
import {
  formatRoundLabel,
  latexdiffDisplayName,
  type LatexdiffEntry,
} from '@texra/shared/plugins/documentOutputs';
import { designTokens, commonViewStyles } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - progress view events

// Local imports - progress view helpers
import { buildDetailsSummary } from '../formatters/htmlBuilders';

// Local imports - styles
import { bannerDetailsWaDetailsStyles } from '../styles/logEntryStyles';

/** Status wa-icon name lookup for latexdiff entries. */
const LATEXDIFF_STATUS_ICONS: Record<LatexdiffEntry['status'], TeXRAIconName> =
  {
    ok: 'check',
    failed: 'circle-exclamation',
  };

/** Screen-reader labels for the otherwise icon-only result status. */
const LATEXDIFF_STATUS_LABELS: Record<LatexdiffEntry['status'], string> = {
  ok: 'Comparison succeeded',
  failed: 'Comparison failed',
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

      .file-link.btn-ghost {
        flex-shrink: 1;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .file-link::part(base) {
        white-space: normal;
      }

      .arrow {
        flex-shrink: 0;
      }
    `,
  ];

  /** The round the entries diff. */
  @property({ attribute: false }) round = 0;

  /** The round's latexdiff entries, from the run's documents. */
  @property({ attribute: false }) entries: readonly LatexdiffEntry[] = [];

  private handleFileClick(filePath: string): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'openFile', path: filePath, line: null }),
    );
  }

  private renderFileLink(
    filePath: string,
    label: string,
    accessibleLabel: string,
  ): TemplateResult {
    return html`<wa-button
      class="file-link btn-ghost is-link"
      appearance="plain"
      size="s"
      data-file=${filePath}
      @click=${() => this.handleFileClick(filePath)}
      ><span aria-hidden="true">${label}</span
      ><span class="visually-hidden">${accessibleLabel}</span></wa-button
    >`;
  }

  private renderEntry(entry: LatexdiffEntry, index: number): TemplateResult {
    const displayName = latexdiffDisplayName(entry);
    const statusLabel = LATEXDIFF_STATUS_LABELS[entry.status];
    const baseLabel =
      entry.baseRound === null
        ? displayName
        : `${displayName} [${formatRoundLabel(entry.baseRound)}]`;
    const revisedLabel = `[${formatRoundLabel(this.round)}]`;

    const entryId = `latexdiff-entry-${index}`;
    return html`
      <li id=${entryId} class="detail-item">
        ${waIcon(LATEXDIFF_STATUS_ICONS[entry.status], { label: statusLabel })}
        ${this.renderFileLink(entry.base.absolutePath, baseLabel, `Open base file: ${baseLabel}`)}
        ${waIcon('arrow-right', { className: 'arrow' })}
        ${this.renderFileLink(
          entry.revised.absolutePath,
          revisedLabel,
          `Open revised file ${revisedLabel} for ${displayName}`,
        )}
        ${
          entry.status === 'ok'
            ? html`(${this.renderFileLink(entry.diff.absolutePath, 'diff', `Open ${displayName} diff`)})`
            : html`<wa-tooltip for=${entryId}>${entry.error}</wa-tooltip>`
        }
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
      <wa-details class="banner-details" appearance="plain" open>
        ${buildDetailsSummary({
          iconName: 'code-compare',
          label: summaryText,
        })}
        <ul class="latexdiff-content">
          ${repeat(
            this.entries,
            (entry, index) =>
              `${entry.base.absolutePath}-${entry.revised.absolutePath}-${entry.baseRound ?? 'base'}-${index}`,
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
