import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import './TexraDiffView';
import { html, nothing, render, type TemplateResult } from 'lit';

import { DESKTOP_THEME_KIND, type Theme } from '@shared/schemas';
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
   * Drop the retained reviews `previewId` opened and no others, re-selecting
   * one the pane still holds if the closed diff was the one on screen.
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

  // Keyed by displayPath, one retained review per path; each entry carries
  // the `previewId` of the diff that opened it, which is what a close names.
  const entries = new Map<string, DesktopShowDiffMessage>();
  let selectedPath: string | undefined;
  let filter = '';

  function visibleEntries(): readonly DesktopShowDiffMessage[] {
    const query = filter.trim().toLocaleLowerCase();
    const values = [...entries.values()];
    if (!query) return values;
    return values.filter((entry) =>
      `${entry.displayPath} ${entry.title}`.toLocaleLowerCase().includes(query),
    );
  }

  function select(entry: DesktopShowDiffMessage): void {
    selectedPath = entry.displayPath;
    diffView.originalText = entry.originalText;
    diffView.proposedText = entry.proposedText;
    diffView.language = entry.language;
    rerender();
  }

  function renderTree(
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
            ${renderTree(node.children, depth + 1)}
          </wa-details>
        `;
      }
      const entry = entries.get(node.path);
      if (!entry) return html``;
      const active = entry.displayPath === selectedPath;
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
    selectedPath = undefined;
    rerender();
  }

  function rerender(): void {
    const visible = visibleEntries();
    const selected = selectedPath ? entries.get(selectedPath) : undefined;
    let additions = 0;
    let deletions = 0;
    for (const entry of entries.values()) {
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
            ${entries.size} ${entries.size === 1 ? 'file' : 'files'}
          </span>
        </header>
        <div class="desktop-review-layout">
          <main class="desktop-review-editor">
            ${
              selected
                ? diffView
                : renderEmptyState({
                    icon: 'plus-minus',
                    title: 'No changes to review',
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
      for (const [path, entry] of entries) {
        if (entry.previewId === previewId) entries.delete(path);
      }
      const remaining = [...entries.values()];
      if (selectedPath !== undefined && !entries.has(selectedPath)) {
        // The diff on screen went with the close. Show one the pane still
        // holds rather than blanking a review nobody dismissed.
        selectedPath = undefined;
        if (remaining[0]) select(remaining[0]);
      }
      rerender();
      return remaining.length === 0;
    },
    open(payload) {
      entries.set(payload.displayPath, payload);
      select(payload);
    },
    setTheme(nextTheme) {
      diffView.hostTheme = nextTheme;
    },
  };
}
