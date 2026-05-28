// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';

import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

// Reuse the production FileList — it lives INSIDE the conversation column
// (stacked below the log), matching WorkflowStreamContent's vertical layout.
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

/** Sample stream-tabs rail entries — matches what ProgressApp passes
 *  into the right-hand <stream-tabs> in production. */
const SAMPLE_RAIL: Array<{
  id: string;
  label: string;
  meta: string;
  status: 'running' | 'ready' | 'finished';
  icon: string;
  active?: boolean;
}> = [
  {
    id: 'polish',
    label: 'manuscript_revised — polish',
    meta: 'workflow · 02:14',
    status: 'running',
    icon: 'pencil',
    active: true,
  },
  {
    id: 'figures',
    label: 'figures.tex — tikz tighten',
    meta: 'tool-use · 14m',
    status: 'finished',
    icon: 'wand-magic-sparkles',
  },
  {
    id: 'review',
    label: 'reviewer-response — draft',
    meta: 'workflow · 1h',
    status: 'finished',
    icon: 'messages',
  },
  {
    id: 'bib',
    label: 'bibliography sync',
    meta: 'tool-use · 3h',
    status: 'finished',
    icon: 'book',
  },
];

/**
 * Static layout mock of the ProgressBoard split, mirroring production:
 *   - Left column (wide, ~75%): the active stream's conversation —
 *     stream-header → live log → file-list (stacked vertically, as in
 *     WorkflowStreamContent).
 *   - Right column (narrow rail, ~25%): the stream-tabs list of all runs
 *     (active highlighted, finished dimmed). Equivalent to the
 *     `<stream-tabs>` rail in `slot="end"` of `ProgressApp`'s
 *     `wa-split-panel`.
 * Editors are not shown — opening a file is delegated to the host.
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
        grid-template-columns: minmax(0, 1fr) minmax(200px, 240px);
        gap: 0;
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

      .col--conversation {
        border-right: var(--border-thin) solid var(--color-border);
      }

      @media (max-width: 720px) {
        .col--conversation {
          border-right: none;
          border-bottom: var(--border-thin) solid var(--color-border);
        }
      }

      /* ---- Conversation column ---- */

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

      /* file-list sits inside the conversation column, separated from the
         log by a hairline divider — same vertical stacking as
         WorkflowStreamContent uses in production. */
      .files-block {
        border-top: var(--border-thin) solid var(--color-border);
        padding: var(--wa-space-2xs) var(--wa-space-s) var(--wa-space-xs);
        background: var(--wa-color-surface-raised, transparent);
      }

      /* ---- Stream-tabs rail (right column) ---- */

      .rail {
        display: flex;
        flex-direction: column;
        background: var(--wa-color-surface-default, transparent);
      }

      .rail__list {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
        padding: var(--wa-space-2xs);
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      .rail__tab {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        border: var(--border-thin) solid transparent;
        border-radius: var(--border-radius);
        cursor: pointer;
        min-width: 0;
      }

      .rail__tab--active {
        background-color: color-mix(
          in srgb,
          var(--wa-color-brand-fill-loud, var(--color-info)) 12%,
          transparent
        );
        border-color: var(--color-border);
      }

      .rail__tab--finished {
        opacity: var(--opacity-subtle, 0.62);
      }

      .rail__icon {
        flex-shrink: 0;
        color: var(--wa-color-text-quiet);
      }

      .rail__tab--active .rail__icon {
        color: var(--wa-color-brand-text-loud);
      }

      .rail__body {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
      }

      .rail__label {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .rail__meta {
        font-size: var(--font-size-xs);
        color: var(--wa-color-text-quiet);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .rail__status {
        flex-shrink: 0;
      }

      .rail__footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--wa-space-2xs) var(--wa-space-s);
        border-top: var(--border-thin) solid var(--color-border);
        font-size: var(--font-size-xs);
        color: var(--wa-color-text-quiet);
      }

      .rail__filter {
        display: inline-flex;
        gap: var(--wa-space-3xs);
      }

      .rail__filter-pill {
        padding: 0 var(--wa-space-2xs);
        border-radius: 999px;
        border: var(--border-thin) solid var(--color-border);
      }

      .rail__filter-pill--active {
        background: var(--wa-color-surface-raised, transparent);
        color: var(--wa-color-text-normal);
      }
    `,
  ];

  @state() private filesByRound = SAMPLE_FILES;
  @query('file-list') private fileListEl?: HTMLElement;

  override async firstUpdated(): Promise<void> {
    // Wait for the production <file-list> and its <wa-details> to upgrade
    // so the imperative open below targets a real shadow tree.
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
        <div class="col col--conversation">${this.renderConversation()}</div>
        <div class="col rail">${this.renderRail()}</div>
      </div>
    `;
  }

  private renderConversation(): TemplateResult {
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
      <div class="files-block">
        <file-list
          .filesByRound=${this.filesByRound}
          .failuresByRound=${{}}
          .showRoundHeaders=${false}
        ></file-list>
      </div>
    `;
  }

  private renderRail(): TemplateResult {
    return html`
      <div class="rail__list" role="list">
        ${SAMPLE_RAIL.map((tab) => this.renderRailTab(tab))}
      </div>
      <div class="rail__footer">
        <div class="rail__filter" aria-label="Stream filter">
          <span class="rail__filter-pill rail__filter-pill--active">All</span>
          <span class="rail__filter-pill">Workflow</span>
          <span class="rail__filter-pill">Tool-use</span>
        </div>
        <wa-icon
          library=${TEXRA_ICON_LIBRARY}
          name="trash"
          variant="solid"
          aria-hidden="true"
        ></wa-icon>
      </div>
    `;
  }

  private renderRailTab(tab: (typeof SAMPLE_RAIL)[number]): TemplateResult {
    const classes = [
      'rail__tab',
      tab.active ? 'rail__tab--active' : '',
      tab.status === 'finished' ? 'rail__tab--finished' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const statusClass =
      tab.status === 'running'
        ? 'is-running'
        : tab.status === 'finished'
          ? 'is-ready'
          : 'is-ready';
    return html`
      <div class=${classes} role="listitem">
        <wa-icon
          class="rail__icon"
          library=${TEXRA_ICON_LIBRARY}
          name=${tab.icon}
          variant="solid"
          aria-hidden="true"
        ></wa-icon>
        <div class="rail__body">
          <div class="rail__label">${tab.label}</div>
          <div class="rail__meta">${tab.meta}</div>
        </div>
        <span
          class="status-indicator rail__status ${statusClass}"
          aria-hidden="true"
        ></span>
      </div>
    `;
  }
}
