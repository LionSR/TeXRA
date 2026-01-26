/**
 * LatexdiffResults component for displaying latexdiff comparison results.
 *
 * Renders a collapsible details section with file comparison entries.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - shared styles
import { designTokens } from '@shared/styles/litStyles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - shared utilities
import { CHEVRON_RIGHT_CLASS } from '@shared/utils/icons';

// Local imports - schemas
import type { DiffResultDisplay, DiffStatus } from '@shared/schemas';

/** Status icon class lookup for latexdiff entries. */
const LATEXDIFF_STATUS_ICONS: Record<DiffStatus, string> = {
  success: 'codicon-check',
  error: 'codicon-error',
};

@customElement('latexdiff-results')
export class LatexdiffResults extends LitElement {
  static override styles = [
    designTokens,
    codiconIconClasses,
    css`
      :host {
        display: block;
        margin: var(--spacing-small) 0;
      }

      details {
        margin: 0;
      }

      summary {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) 0;
        cursor: pointer;
        list-style: none;
        user-select: none;
        opacity: var(--opacity-normal);
      }

      summary:hover {
        opacity: 1;
      }

      summary::-webkit-details-marker {
        display: none;
      }

      .toggle-icon {
        opacity: var(--opacity-subtle);
        font-size: var(--font-size-sm);
      }

      .latexdiff-content {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .detail-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
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
  @property({ type: String }) logId = '';

  /** Run ID for tracking */
  @property({ type: String }) runId = '';

  /** Diff result entries to display */
  @property({ type: Array }) entries: DiffResultDisplay[] = [];

  private handleFileClick(filePath: string): void {
    // Dispatch event for parent to handle file opening
    this.dispatchEvent(
      new CustomEvent('file-click', {
        detail: { file: filePath },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderFileLink(filePath: string, label: string): TemplateResult {
    if (!filePath) {
      return html`<span>${label}</span>`;
    }
    return html`<span
      class="file-link"
      data-file=${filePath}
      @click=${() => this.handleFileClick(filePath)}
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
        <i class="codicon ${icon}"></i>
        ${this.renderFileLink(baseFile, baseLabel)}
        <span class="arrow">→</span>
        ${this.renderFileLink(revisedFile, revisedLabel)}
        (${this.renderFileLink(diffFile, 'diff')})
      </li>
    `;
  }

  override render(): TemplateResult {
    if (this.entries.length === 0) {
      return html`${nothing}`;
    }

    const summaryText =
      this.entries.length === 1
        ? 'Latexdiff result'
        : `Latexdiff results (${this.entries.length})`;

    // Note: CSS rotation via details[open] handles the icon direction
    return html`
      <details open>
        <summary>
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          <i class="codicon codicon-diff"></i>
          <span>${summaryText}</span>
        </summary>
        <ul
          class="latexdiff-content"
          data-log-id=${this.logId}
          data-run-id=${ifDefined(this.runId || undefined)}
        >
          ${repeat(
            this.entries,
            (entry) => `${entry.baseFile}-${entry.revisedFile}`,
            (entry) => this.renderEntry(entry),
          )}
        </ul>
      </details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'latexdiff-results': LatexdiffResults;
  }
}
