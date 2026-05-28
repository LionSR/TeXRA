// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';

import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

// Reuse the production FileList so the right-hand "Run outputs" panel
// matches the real progress board, not a hand-rolled approximation.
import '@progressView/frontend/components/FileList';

import type { OutputFileInfo } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { statusIndicatorStyles } from '@shared/styles/statusIndicatorStyles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

/** Realistic OutputFileInfo fixture for the production <file-list>. */
function mockFile(
  relative: string,
  diff: { added: number; removed: number },
): OutputFileInfo {
  return {
    source: relative,
    location: {
      kind: 'workspace',
      absolutePath: `/workspace/${relative}`,
      relativePath: relative,
    },
    round: 1,
    lineage: null,
    diff,
  };
}

const SAMPLE_FILES: Record<string, OutputFileInfo[]> = {
  '1': [
    mockFile('manuscript_revised.tex', { added: 142, removed: 89 }),
    mockFile('abstract_draft.tex', { added: 18, removed: 0 }),
    mockFile('change_summary.md', { added: 24, removed: 0 }),
  ],
};

/**
 * Static layout mock of a proposed split ProgressBoard:
 *   - Left column: stream header + live log
 *   - Right column: run's output files (rendered via the production
 *     `<file-list>` so the panel matches the real board)
 * Editors are intentionally not shown — opening a file is delegated to
 * the host (VS Code / desktop).
 */
@customElement('texra-progress-board-layout-mock')
export class ProgressBoardLayoutMock extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    statusIndicatorStyles,
    css`
      :host {
        display: block;
      }

      .board {
        display: grid;
        grid-template-columns: minmax(0, 1.6fr) minmax(220px, 1fr);
        gap: var(--wa-space-s);
        min-height: 360px;
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--wa-border-radius-m);
        background: var(--wa-color-surface-default, transparent);
        overflow: hidden;
      }

      @media (max-width: 720px) {
        .board {
          grid-template-columns: minmax(0, 1fr);
        }
      }

      .col {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .col--left {
        border-right: var(--border-thin) solid var(--color-border);
      }

      @media (max-width: 720px) {
        .col--left {
          border-right: none;
          border-bottom: var(--border-thin) solid var(--color-border);
        }
      }

      .stream-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-2xs) var(--wa-space-s);
        border-bottom: var(--border-thin) solid var(--color-border);
        background: var(--wa-color-surface-raised, transparent);
      }

      .stream-header__title {
        font-weight: var(--font-weight-medium);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .stream-header__meta {
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet);
        white-space: nowrap;
      }

      .log {
        flex: 1;
        overflow: hidden;
        padding: var(--wa-space-2xs) var(--wa-space-s);
        font-size: var(--font-size-sm);
        line-height: 1.45;
        font-family: var(
          --wa-font-family-mono,
          ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace
        );
        background: var(--wa-color-surface-default, transparent);
      }

      .log__line {
        white-space: pre-wrap;
        word-break: break-word;
      }

      .log__line--turn {
        margin-top: var(--wa-space-2xs);
        font-weight: var(--font-weight-medium);
        color: var(--wa-color-text-normal);
      }

      .log__line--tool {
        color: var(--wa-color-brand-text-loud);
      }

      .log__line--ok {
        color: var(--wa-color-success-text-loud);
      }

      .log__line--info {
        color: var(--wa-color-text-quiet);
      }

      .log__cursor::after {
        content: '▍';
        margin-left: 2px;
        color: var(--wa-color-brand-text-loud);
        animation: blink 1s steps(2) infinite;
      }

      @keyframes blink {
        50% {
          opacity: 0;
        }
      }

      .files-col {
        padding: var(--wa-space-s);
        gap: var(--wa-space-2xs);
      }

      .files-col__title {
        display: flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        margin-bottom: var(--wa-space-2xs);
        font-weight: var(--font-weight-medium);
      }

      .files-col__title small {
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight);
      }
    `,
  ];

  @state() private filesByRound = SAMPLE_FILES;
  @query('file-list') private fileListEl?: HTMLElement;

  override async firstUpdated(): Promise<void> {
    // Wait for the production <file-list> and wa-details to upgrade so the
    // imperative open below targets a real shadow tree.
    await customElements.whenDefined('file-list');
    await customElements.whenDefined('wa-details');
    await Promise.resolve();
    const root = this.fileListEl?.shadowRoot;
    if (!root) return;
    for (const det of root.querySelectorAll('wa-details')) {
      (det as HTMLElement & { open: boolean }).open = true;
    }
  }

  override render(): TemplateResult {
    return html`
      <div class="board">
        <div class="col col--left">${this.renderLeft()}</div>
        <div class="col files-col">${this.renderRight()}</div>
      </div>
    `;
  }

  private renderLeft(): TemplateResult {
    return html`
      <div class="stream-header">
        <span class="status-indicator is-running" aria-hidden="true"></span>
        <span class="stream-header__title">
          manuscript_revised.tex — polish workflow
        </span>
        <wa-tag size="small" variant="brand">Running</wa-tag>
        <span class="stream-header__meta">opus-4.7 · 02:14</span>
      </div>
      <div class="log" aria-label="Live log">
        <div class="log__line log__line--turn">
          → user: Polish the introduction; tighten the abstract.
        </div>
        <div class="log__line log__line--info">
          [thinking] Skim outline, identify weak transitions, plan two passes.
        </div>
        <div class="log__line log__line--tool">
          ⚙ read_file manuscript.tex (1,824 lines)
        </div>
        <div class="log__line log__line--ok">
          ✓ extracted 12 sections, 38 paragraphs
        </div>
        <div class="log__line log__line--tool">
          ⚙ edit intro paragraph 1 — clarity pass
        </div>
        <div class="log__line log__line--ok">
          ✓ applied 4 edits, 0 conflicts
        </div>
        <div class="log__line log__line--turn">
          → assistant: Rewriting abstract for tone and length…
        </div>
        <div class="log__line log__cursor">
          Drafting new abstract opening: "We present a unified
        </div>
      </div>
    `;
  }

  private renderRight(): TemplateResult {
    const count = Object.values(this.filesByRound).reduce(
      (n, files) => n + files.length,
      0,
    );
    return html`
      <div class="files-col__title">
        <wa-icon
          library=${TEXRA_ICON_LIBRARY}
          name="folder"
          variant="solid"
        ></wa-icon>
        Run outputs
        <small>${count} files</small>
      </div>
      <file-list
        .filesByRound=${this.filesByRound}
        .failuresByRound=${{}}
        .showRoundHeaders=${false}
      ></file-list>
    `;
  }
}
