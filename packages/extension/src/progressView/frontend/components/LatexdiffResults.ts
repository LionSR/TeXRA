/** Collapsible latexdiff comparison results panel. */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { ifDefined } from 'lit/directives/if-defined.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import type { DiffResultDisplay, DiffStatus } from '@shared/schemas';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

// Local imports - progress view events
import { ProgressEvents } from '../events';

// Local imports - progress view helpers
import { buildDetailsSummary } from '../formatters/htmlBuilders';

/** Status wa-icon name lookup for latexdiff entries. */
const LATEXDIFF_STATUS_ICONS: Record<DiffStatus, string> = {
  success: 'check',
  error: 'error',
};

@customElement('latexdiff-results')
export class LatexdiffResults extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      wa-details {
        margin: var(--wa-space-2xs) 0;
        content-visibility: auto;
        contain-intrinsic-size: auto 40px;
      }

      .latexdiff-content {
        list-style: none;
        margin: 0;
        padding: var(--wa-space-3xs) 0 var(--wa-space-2xs) var(--wa-space-s);
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
      }

      /* .detail-item base styles are in commonViewStyles */
      .detail-item {
        flex-wrap: wrap;
      }

      .file-link {
        color: var(--color-text-link);
        cursor: pointer;
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

  private renderFileLink(filePath: string, label: string): TemplateResult {
    if (!filePath) {
      return html`<span>${label}</span>`;
    }
    return html`<span
      class="file-link"
      data-file=${filePath}
      role="button"
      tabindex="0"
      @click=${() => this.handleFileClick(filePath)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.handleFileClick(filePath);
        }
      }}
      >${label}</span
    >`;
  }

  private renderEntry(entry: DiffResultDisplay): TemplateResult {
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
    const baseLabel =
      baseRound === null ? displayName : `${displayName} [r${baseRound}]`;
    const revisedLabel = `[r${revisedRound}]`;

    return html`
      <li
        class="detail-item"
        data-run-id=${ifDefined(runId)}
        title=${ifDefined(message)}
      >
        <wa-icon
          library=${TEXRA_ICON_LIBRARY}
          name=${icon}
          aria-hidden="true"
        ></wa-icon>
        ${this.renderFileLink(baseFile, baseLabel)}
        <wa-icon
          class="arrow"
          library=${TEXRA_ICON_LIBRARY}
          name="arrow-right"
          aria-hidden="true"
        ></wa-icon>
        ${this.renderFileLink(revisedFile, revisedLabel)}
        (${this.renderFileLink(diffFile, 'diff')})
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
          iconName: 'diff',
          label: summaryText,
        })}
        <ul class="latexdiff-content">
          ${repeat(
            this.entries,
            (entry, index) =>
              `${entry.baseFile}-${entry.revisedFile}-${entry.baseRound ?? 'base'}-${entry.revisedRound ?? 'rev'}-${index}`,
            (entry) => this.renderEntry(entry),
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
