// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

/**
 * Static layout mock of a proposed split ProgressBoard:
 *   - Left column: stream header + live log
 *   - Right column: run's output files
 * Editors are intentionally not shown — opening a file is delegated to
 * the host (VS Code / desktop), keeping the board focused on chat + diffs.
 */
@customElement('texra-progress-board-layout-mock')
export class ProgressBoardLayoutMock extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
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
        font-size: var(--font-size-small);
        color: var(--wa-color-text-quiet);
        white-space: nowrap;
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--wa-color-success-fill-loud);
        box-shadow: 0 0 0 3px var(--wa-color-success-fill-quiet);
        flex-shrink: 0;
      }

      .status-dot--running {
        background: var(--wa-color-brand-fill-loud);
        box-shadow: 0 0 0 3px var(--wa-color-brand-fill-quiet);
        animation: pulse 1.8s ease-in-out infinite;
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.55;
        }
      }

      .log {
        flex: 1;
        overflow: hidden;
        padding: var(--wa-space-2xs) var(--wa-space-s);
        font-size: var(--font-size-small);
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
        font-weight: var(--font-weight-medium);
        margin-bottom: var(--wa-space-2xs);
        display: flex;
        align-items: center;
        gap: var(--wa-space-3xs);
      }

      .files-col__title small {
        font-weight: var(--font-weight-normal);
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-small);
      }

      .file-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-2xs);
        border-radius: var(--wa-border-radius-s);
        border: var(--border-thin) solid transparent;
        cursor: default;
      }

      .file-row:hover {
        background: var(--wa-color-neutral-fill-quiet);
        border-color: var(--color-border);
      }

      .file-row__icon {
        font-size: var(--font-size-icon);
        color: var(--wa-color-text-quiet);
      }

      .file-row__body {
        flex: 1;
        min-width: 0;
      }

      .file-row__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .file-row__meta {
        font-size: var(--font-size-xs, 11px);
        color: var(--wa-color-text-quiet);
      }

      .file-row__diff {
        font-variant-numeric: tabular-nums;
        font-size: var(--font-size-small);
        white-space: nowrap;
      }

      .file-row__diff .add {
        color: var(--wa-color-success-text-loud);
      }
      .file-row__diff .del {
        color: var(--wa-color-danger-text-loud);
      }

      .files-col__hint {
        margin-top: var(--wa-space-s);
        padding: var(--wa-space-2xs);
        border-top: var(--border-thin) dashed var(--color-border);
        font-size: var(--font-size-small);
        color: var(--wa-color-text-quiet);
      }
    `,
  ];

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
        <span class="status-dot status-dot--running" aria-hidden="true"></span>
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
    return html`
      <div class="files-col__title">
        <wa-icon
          library=${TEXRA_ICON_LIBRARY}
          name="folder"
          variant="solid"
        ></wa-icon>
        Run outputs
        <small>3 files</small>
      </div>

      ${this.renderFile({
        name: 'manuscript_revised.tex',
        meta: 'edited · 02:14',
        add: 142,
        del: 89,
      })}
      ${this.renderFile({
        name: 'abstract_draft.tex',
        meta: 'new · 02:13',
        add: 18,
        del: 0,
      })}
      ${this.renderFile({
        name: 'change_summary.md',
        meta: 'new · 02:13',
        add: 24,
        del: 0,
      })}

      <div class="files-col__hint">
        Click to open in the host editor — the board itself doesn't render
        editors.
      </div>
    `;
  }

  private renderFile(opts: {
    name: string;
    meta: string;
    add: number;
    del: number;
  }): TemplateResult {
    return html`
      <div class="file-row" tabindex="0">
        <wa-icon
          class="file-row__icon"
          library=${TEXRA_ICON_LIBRARY}
          name="file"
          variant="solid"
        ></wa-icon>
        <div class="file-row__body">
          <div class="file-row__name">${opts.name}</div>
          <div class="file-row__meta">${opts.meta}</div>
        </div>
        <div class="file-row__diff">
          <span class="add">+${opts.add}</span>
          <span class="del">−${opts.del}</span>
        </div>
      </div>
    `;
  }
}
