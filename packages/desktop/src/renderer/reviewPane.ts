import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@progressView/frontend/components/TexraDiffView';
import { html, nothing, render, type TemplateResult } from 'lit';

import {
  DESKTOP_THEME_KIND,
  type DesktopThemeKind,
} from '@shared/schemas/commonViewMessages';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import type { DesktopShowDiffMessage } from '../desktopDiffMessages';
import './reviewPane.css';

interface DiffViewElement extends HTMLElement {
  fill: boolean;
  hostTheme: string;
  language: string;
  originalText: string;
  proposedText: string;
}

interface ReviewEntry extends DesktopShowDiffMessage {
  readonly key: string;
  readonly path: string;
}

interface ReviewTreeNode {
  readonly children: Map<string, ReviewTreeNode>;
  entry?: ReviewEntry;
}

export interface ReviewPaneController {
  readonly element: HTMLElement;
  clear(): void;
  open(payload: DesktopShowDiffMessage): void;
  setTheme(theme: DesktopThemeKind): void;
}

function reviewPath(payload: DesktopShowDiffMessage): string {
  return (
    payload.displayPath ??
    payload.proposedPath ??
    payload.originalPath ??
    payload.title
  );
}

function buildReviewTree(entries: readonly ReviewEntry[]): ReviewTreeNode {
  const root: ReviewTreeNode = { children: new Map() };
  for (const entry of entries) {
    const segments = entry.path.split(/[\\/]/).filter(Boolean);
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.entry = entry;
  }
  return root;
}

function sortedTreeChildren(
  node: ReviewTreeNode,
): readonly [string, ReviewTreeNode][] {
  return [...node.children.entries()].toSorted((left, right) => {
    const leftIsDirectory = left[1].children.size > 0;
    const rightIsDirectory = right[1].children.size > 0;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }
    return left[0].localeCompare(right[0]);
  });
}

export function createReviewPane(): ReviewPaneController {
  const element = document.createElement('section');
  element.className = 'desktop-review-pane';
  const diffView = document.createElement('texra-diff-view') as DiffViewElement;
  diffView.className = 'desktop-review-diff';
  diffView.fill = true;

  const entries = new Map<string, ReviewEntry>();
  let selectedKey: string | undefined;
  let filter = '';
  let theme: DesktopThemeKind = DESKTOP_THEME_KIND.DARK;

  function selectedEntry(): ReviewEntry | undefined {
    return selectedKey ? entries.get(selectedKey) : undefined;
  }

  function visibleEntries(): readonly ReviewEntry[] {
    const query = filter.trim().toLocaleLowerCase();
    const values = [...entries.values()];
    if (!query) return values;
    return values.filter((entry) =>
      `${entry.path} ${entry.title}`.toLocaleLowerCase().includes(query),
    );
  }

  function select(entry: ReviewEntry): void {
    selectedKey = entry.key;
    diffView.originalText = entry.originalText;
    diffView.proposedText = entry.proposedText;
    diffView.language = entry.language;
    rerender();
  }

  function renderTree(
    node: ReviewTreeNode,
    depth = 0,
  ): readonly TemplateResult[] {
    return sortedTreeChildren(node).map(([label, child]) => {
      if (child.children.size > 0) {
        return html`
          <wa-details
            class="desktop-review-directory"
            style=${`--review-tree-depth: ${depth}`}
            open
          >
            <span slot="summary">
              ${waIcon('chevron-down')} ${waIcon('folder')}
              <span>${label}</span>
            </span>
            ${renderTree(child, depth + 1)}
          </wa-details>
        `;
      }
      const entry = child.entry;
      if (!entry) return html``;
      const active = entry.key === selectedKey;
      return html`
        <wa-button
          type="button"
          class="desktop-review-file btn-ghost"
          style=${`--review-tree-depth: ${depth}`}
          appearance="plain"
          size="s"
          data-active=${active ? 'true' : 'false'}
          title=${entry.path}
          @click=${() => select(entry)}
        >
          ${waIcon('file-code', { slot: 'start' })}
          <span>${label}</span>
          <span class="desktop-review-file-state" slot="end"></span>
        </wa-button>
      `;
    });
  }

  function rerender(): void {
    const visible = visibleEntries();
    const selected = selectedEntry();
    const additions = [...entries.values()].reduce(
      (total, entry) => total + entry.additions,
      0,
    );
    const deletions = [...entries.values()].reduce(
      (total, entry) => total + entry.deletions,
      0,
    );
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
                : html`
                    <div class="desktop-review-empty">
                      ${waIcon('diff-multiple')}
                      <strong>No changes to review</strong>
                    </div>
                  `
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
                  ? html`
                      <wa-button
                        slot="end"
                        class="icon-button is-size-s"
                        appearance="plain"
                        size="s"
                        aria-label="Clear file filter"
                        @click=${() => {
                          filter = '';
                          rerender();
                        }}
                      >
                        ${waIcon('xmark')}
                      </wa-button>
                    `
                  : nothing
              }
            </wa-input>
            <div class="desktop-review-tree">
              ${
                visible.length > 0
                  ? renderTree(buildReviewTree(visible))
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

  diffView.hostTheme = theme;
  rerender();

  return {
    element,
    clear() {
      entries.clear();
      selectedKey = undefined;
      rerender();
    },
    open(payload) {
      const path = reviewPath(payload);
      const entry = { ...payload, key: path, path };
      entries.set(path, entry);
      select(entry);
    },
    setTheme(nextTheme) {
      theme = nextTheme;
      diffView.hostTheme = theme;
    },
  };
}
