import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import './TexraDiffView';
import { html, nothing, render, type TemplateResult } from 'lit';

import { DESKTOP_THEME_KIND, type Theme } from '@texra/shared/ipc';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { renderEmptyState } from '@ui/wa/emptyState';
import { waIcon } from '@ui/wa/webAwesomeIcons';

import { buildEditorTree, type EditorTreeNode } from './editorTree';
import type { DesktopShowDiffMessage } from '../shared/desktopDiffMessages';
import './reviewPane.css';

interface DiffViewElement extends HTMLElement {
  fill: boolean;
  hostTheme: Theme;
  language: string;
  originalText: string;
  proposedText: string;
}

interface ReviewPaneController {
  readonly element: HTMLElement;
  /** Drop every retained review, whatever opened it (the window closing). */
  clear(): void;
  /**
   * Drop the review `previewId` opened and no other, re-selecting one the
   * pane still holds (the same file's first) if it was the one on screen.
   * Reports whether the pane is now empty, which is when the Review tab has
   * nothing left to show.
   */
  close(previewId: string): boolean;
  open(payload: DesktopShowDiffMessage): void;
  setTheme(theme: Theme): void;
}

export function createReviewPane(): ReviewPaneController {
  const element = document.createElement('section');
  element.className = 'desktop-review-pane';
  const diffView = document.createElement('texra-diff-view') as DiffViewElement;
  diffView.className = 'desktop-review-diff';
  diffView.fill = true;

  // Keyed by `previewId`, the diff a close names, in the order they opened:
  // two pending edits of one file (parallel subagents) are two reviews, and
  // settling one never drops the other. The tree shows each path's newest.
  const entries = new Map<string, DesktopShowDiffMessage>();
  let selectedId: string | undefined;
  let filter = '';

  /** Each path's newest review, which is the one its tree entry shows. */
  function newestByPath(): Map<string, DesktopShowDiffMessage> {
    return new Map(
      [...entries.values()].map((entry) => [entry.displayPath, entry]),
    );
  }

  function visibleEntries(
    shown: Map<string, DesktopShowDiffMessage>,
  ): readonly DesktopShowDiffMessage[] {
    const query = filter.trim().toLocaleLowerCase();
    const values = [...shown.values()];
    if (!query) return values;
    return values.filter((entry) =>
      `${entry.displayPath} ${entry.title}`.toLocaleLowerCase().includes(query),
    );
  }

  function select(entry: DesktopShowDiffMessage): void {
    selectedId = entry.previewId;
    diffView.originalText = entry.originalText;
    diffView.proposedText = entry.proposedText;
    diffView.language = entry.language;
    rerender();
  }

  function renderTree(
    shown: Map<string, DesktopShowDiffMessage>,
    nodes: readonly EditorTreeNode[],
    depth = 0,
  ): readonly TemplateResult[] {
    return nodes.map((node) => {
      if (node.kind === 'directory') {
        return html`
          <wa-details
            class="desktop-review-directory"
            style=${`--review-tree-depth: ${depth}`}
            icon-placement="start"
            open
          >
            <span slot="summary">
              ${waIcon('folder')}
              <span>${node.name}</span>
            </span>
            ${renderTree(shown, node.children, depth + 1)}
          </wa-details>
        `;
      }
      const entry = shown.get(node.path);
      if (!entry) return html``;
      const active = entry.previewId === selectedId;
      return html`
        <wa-button
          type="button"
          class="desktop-review-file btn-ghost"
          style=${`--review-tree-depth: ${depth}`}
          appearance="plain"
          size="s"
          data-active=${active ? 'true' : 'false'}
          title=${entry.displayPath}
          @click=${() => select(entry)}
        >
          ${waIcon('file-code', { slot: 'start' })}
          <span>${node.name}</span>
        </wa-button>
      `;
    });
  }

  function clearEntries(): void {
    entries.clear();
    selectedId = undefined;
    rerender();
  }

  function rerender(): void {
    if (entries.size === 0) {
      // Nothing to count, filter, or pick: one explanation, not a zeroed
      // toolbar beside an empty file list.
      render(
        renderEmptyState({
          icon: 'plus-minus',
          title: 'No changes to review',
          body: 'When an agent proposes edits to your files, the diffs appear here.',
          headingTag: 'h3',
          className: 'desktop-review-empty',
        }),
        element,
      );
      return;
    }
    const shown = newestByPath();
    const visible = visibleEntries(shown);
    const selected = selectedId ? entries.get(selectedId) : undefined;
    let additions = 0;
    let deletions = 0;
    for (const entry of shown.values()) {
      additions += entry.additions;
      deletions += entry.deletions;
    }
    render(
      html`
        <header class="desktop-review-toolbar">
          <div class="desktop-review-summary">
            <strong>${selected?.title ?? 'Review changes'}</strong>
            <span class="desktop-review-counts">
              <span class="is-added">+${additions}</span>
              <span class="is-deleted">-${deletions}</span>
            </span>
          </div>
          <span class="desktop-review-file-count">
            ${shown.size} ${shown.size === 1 ? 'file' : 'files'}
          </span>
        </header>
        <div class="desktop-review-layout">
          <main class="desktop-review-editor">
            ${
              selected
                ? diffView
                : renderEmptyState({
                    icon: 'plus-minus',
                    title: 'Select a file to see its changes',
                    headingTag: 'h3',
                    className: 'desktop-review-empty',
                  })
            }
          </main>
          <aside class="desktop-review-sidebar" aria-label="Changed files">
            <wa-input
              class="desktop-review-filter"
              size="s"
              placeholder="Filter files…"
              aria-label="Filter changed files"
              .value=${filter}
              @input=${(event: Event) => {
                filter = (event.currentTarget as HTMLInputElement).value;
                rerender();
              }}
            >
              ${waIcon('magnifying-glass', { slot: 'start' })}
              ${
                filter
                  ? renderIconActionButton({
                      icon: 'xmark',
                      label: 'Clear file filter',
                      className: 'icon-button is-size-s',
                      slot: 'end',
                      onClick: () => {
                        filter = '';
                        rerender();
                      },
                    })
                  : nothing
              }
            </wa-input>
            <div class="desktop-review-tree">
              ${
                visible.length > 0
                  ? renderTree(
                      shown,
                      buildEditorTree(
                        visible.map((entry) => ({
                          path: entry.displayPath,
                          isDirectory: false,
                        })),
                      ),
                    )
                  : html`
                      <div class="desktop-review-no-results">
                        No matching files
                      </div>
                    `
              }
            </div>
          </aside>
        </div>
      `,
      element,
    );
  }

  diffView.hostTheme = DESKTOP_THEME_KIND.DARK;
  rerender();

  return {
    element,
    clear: clearEntries,
    close(previewId) {
      const closed = entries.get(previewId);
      entries.delete(previewId);
      if (closed && selectedId === previewId) {
        // The diff on screen went with the close. Show the same file's other
        // pending review if there is one, else any the pane still holds,
        // rather than blanking a review nobody dismissed.
        selectedId = undefined;
        const shown = newestByPath();
        const next = shown.get(closed.displayPath) ?? [...shown.values()][0];
        if (next) select(next);
      }
      rerender();
      return entries.size === 0;
    },
    open(payload) {
      // Re-inserted, so a preview opened again is its path's newest.
      entries.delete(payload.previewId);
      entries.set(payload.previewId, payload);
      select(payload);
    },
    setTheme(nextTheme) {
      diffView.hostTheme = nextTheme;
    },
  };
}
