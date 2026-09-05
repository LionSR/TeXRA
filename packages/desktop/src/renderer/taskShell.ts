// Templates for the conversation-first desktop chrome.
//
// These templates intentionally contain no state. The renderer owns resource
// lifecycles and passes callbacks here, while desktopTaskShell.ts owns the pure
// reducer. Keeping the markup separate makes main.ts a composition module
// instead of a second UI component.

import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import { html, nothing, type TemplateResult } from 'lit';

import type { PaperDisplay } from '@shared/session/hostSnapshot';
import type { SessionView } from '@shared/session/sessionView';
import type { Shell } from '@shared/session/shell';
import { resolveSelected, type Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import {
  WORKBENCH_KIND_META,
  type WorkbenchPlacement,
  type WorkbenchTab,
} from '../shared/desktopTaskShell.js';

/** One open paper as the rail lists it: how its host names it, its session,
 *  its surface. */
export interface RailPaper {
  readonly display: PaperDisplay;
  readonly view: SessionView;
  readonly surface: Surface;
}

interface TaskSidebarModel {
  readonly files: Node;
  readonly filesExpanded: boolean;
  /** Every open paper, in `shell.open` order. */
  readonly papers: readonly RailPaper[];
  readonly shell: Shell;
  /** The shown workbench (the active paper's) has its Subagents tab open:
   *  that paper's tree lives there and its section lists top-level streams
   *  only. Other papers' workbenches are not shown, so their sections keep
   *  their trees. */
  readonly subagentsOpen: boolean;
  /** Canonical name of the command palette action, from the command catalog. */
  readonly commandsLabel: string;
}

interface TaskSidebarCallbacks {
  onNewTask(): void;
  onSearch(): void;
  onToggleFiles(): void;
  onOpenFolder(): void;
  onSelectPaper(key: string): void;
  onClosePaper(key: string): void;
  onTogglePaperCollapsed(key: string): void;
  onOpenTerminal(): void;
  onOpenBrowser(): void;
  onOpenSettings(): void;
  onOpenLogs(): void;
}

function sidebarAction(options: {
  icon: TeXRAIconName;
  label: string;
  onClick: () => void;
  primary?: boolean;
}): TemplateResult {
  return html`
    <wa-button
      type="button"
      class="task-sidebar-action btn-ghost"
      appearance="plain"
      size="s"
      data-primary=${options.primary ? 'true' : 'false'}
      @click=${options.onClick}
    >
      ${waIcon(options.icon, {
        className: 'task-sidebar-action-icon',
        slot: 'start',
      })}
      <span>${options.label}</span>
    </wa-button>
  `;
}

/**
 * A collapsed paper's badge: the one count that needs the user first
 * (waiting, then interrupted, then running), read from the view's rollup.
 */
function paperBadge(view: SessionView): TemplateResult | typeof nothing {
  const { waiting, interrupted, running } = view.rollup;
  if (waiting > 0) {
    return html`<wa-badge class="task-paper-badge" variant="warning" pill
      >${waiting}</wa-badge
    >`;
  }
  if (interrupted > 0) {
    return html`<wa-badge class="task-paper-badge" variant="danger" pill
      >${interrupted}</wa-badge
    >`;
  }
  if (running > 0) {
    return html`<wa-badge class="task-paper-badge" variant="success" pill
      >${running}</wa-badge
    >`;
  }
  return nothing;
}

function streamTabsTemplate(
  paper: RailPaper,
  options: { topLevelOnly: boolean },
): TemplateResult {
  return html`<div data-session=${paper.display.key}>
    <stream-tabs
      .view=${paper.view}
      .surface=${paper.surface}
      .topLevelOnly=${options.topLevelOnly}
    ></stream-tabs>
  </div>`;
}

/**
 * Under a selected workflow run the list shows the root alone (W2): its
 * calls are child streams the run board lists, and the note says so. The
 * selection may sit on one of those calls; the note is the family root's.
 */
export function workflowCallsNote(
  view: SessionView,
  surface: Surface,
): TemplateResult | typeof nothing {
  const selected = resolveSelected(view, surface);
  const stream = selected === null ? undefined : view.streams.get(selected);
  const rootId = stream?.ancestors[0]?.id ?? stream?.id;
  const root = rootId === undefined ? undefined : view.streams.get(rootId);
  if (root?.category !== 'workflow' || root.rollup.total === 0) {
    return nothing;
  }
  const { total } = root.rollup;
  return html`<div class="task-workflow-calls-note">
    ${total === 1 ? 'The 1 call is a child stream' : `The ${total} calls are child streams`},
    reachable from the board. They never appear here.
  </div>`;
}

/**
 * One section per open paper: the row, then that paper's own stream tree
 * beneath it unless the user folded the section shut (`Shell.collapsed`).
 * The row chooses the paper; the chevron folds the section; the close
 * control beside them is the one place a paper is closed from. The file
 * tree is the shown paper's workbench tree, so only its section carries the
 * Files disclosure.
 */
function paperSection(
  paper: RailPaper,
  model: TaskSidebarModel,
  callbacks: TaskSidebarCallbacks,
): TemplateResult {
  const { key, name, initials, subtitle } = paper.display;
  const active = key === model.shell.active;
  const collapsed = model.shell.collapsed.includes(key);
  const foldLabel = `${collapsed ? 'Expand' : 'Collapse'} ${name}`;
  return html`
    <div class="task-project-item">
      <wa-button
        type="button"
        class="task-project-row btn-ghost ${active ? 'is-active' : ''}"
        appearance="plain"
        size="s"
        title=${key}
        aria-current=${active ? 'true' : nothing}
        @click=${() => callbacks.onSelectPaper(key)}
      >
        <span class="task-project-mark icon-surface is-size-m"
          >${initials}</span
        >
        <span class="task-project-copy">
          <strong>${name}</strong>
          <small>${subtitle}</small>
        </span>
      </wa-button>
      ${collapsed ? paperBadge(paper.view) : nothing}
      <wa-button
        type="button"
        class="task-project-fold icon-button is-size-s"
        appearance="plain"
        size="s"
        title=${foldLabel}
        aria-label=${foldLabel}
        aria-expanded=${collapsed ? 'false' : 'true'}
        @click=${() => callbacks.onTogglePaperCollapsed(key)}
      >
        ${waIcon(collapsed ? 'chevron-right' : 'chevron-down')}
      </wa-button>
      <wa-button
        type="button"
        class="task-project-close icon-button is-size-s"
        appearance="plain"
        size="s"
        title="Close ${name}"
        aria-label="Close ${name}"
        @click=${() => callbacks.onClosePaper(key)}
      >
        ${waIcon('xmark')}
      </wa-button>
    </div>
    ${
      collapsed
        ? nothing
        : html`
            <div class="task-sidebar-sessions task-paper-streams">
              ${streamTabsTemplate(paper, {
                topLevelOnly: active && model.subagentsOpen,
              })}
              ${workflowCallsNote(paper.view, paper.surface)}
            </div>
          `
    }
    ${
      active && !collapsed
        ? html`
            <wa-button
              type="button"
              class="task-project-files-toggle btn-ghost"
              appearance="plain"
              size="s"
              aria-expanded=${model.filesExpanded ? 'true' : 'false'}
              @click=${callbacks.onToggleFiles}
            >
              ${waIcon(model.filesExpanded ? 'chevron-down' : 'chevron-right', {
                slot: 'start',
              })}
              <span>Files</span>
            </wa-button>
            <div class="task-project-files" ?hidden=${!model.filesExpanded}>
              ${model.files}
            </div>
          `
        : nothing
    }
  `;
}

function papersSectionsTemplate(
  model: TaskSidebarModel,
  callbacks: TaskSidebarCallbacks,
): TemplateResult {
  return html`
    <section class="task-sidebar-section task-project-section">
      <div class="task-sidebar-section-heading">
        <span class="task-sidebar-section-label">
          ${model.papers.length > 1 ? 'Papers' : 'Paper'}
        </span>
        <wa-badge
          class="task-sidebar-section-count"
          variant="neutral"
          appearance="outlined"
          pill
          >${model.papers.length}</wa-badge
        >
      </div>
      ${model.papers.map((paper) => paperSection(paper, model, callbacks))}
      <wa-button
        type="button"
        class="task-project-add"
        appearance="outlined"
        size="s"
        @click=${callbacks.onOpenFolder}
      >
        ${waIcon('folder-open', { slot: 'start' })}
        <span>Add paper</span>
      </wa-button>
    </section>
  `;
}

export function taskSidebarTemplate(
  model: TaskSidebarModel,
  callbacks: TaskSidebarCallbacks,
): TemplateResult {
  let papersBody: TemplateResult;
  if (model.papers.length === 0) {
    papersBody = html`
      <section class="task-sidebar-section task-project-section">
        <wa-button
          type="button"
          class="task-project-row btn-ghost"
          appearance="plain"
          size="s"
          title="Open a project folder"
          @click=${callbacks.onOpenFolder}
        >
          <span class="task-project-mark icon-surface is-size-m">TX</span>
          <span class="task-project-copy">
            <strong>No paper open</strong>
            <small>Get started</small>
          </span>
          ${waIcon('arrow-up-right-from-square', {
            className: 'task-project-chevron',
            slot: 'end',
          })}
        </wa-button>
      </section>
    `;
  } else {
    papersBody = papersSectionsTemplate(model, callbacks);
  }
  return html`
    <aside class="task-sidebar" aria-label="Papers and tasks">
      <header class="task-sidebar-brand">
        <div class="task-sidebar-logo" aria-hidden="true">T</div>
        <span class="task-sidebar-product">TeXRA</span>
        <wa-button
          type="button"
          class="task-sidebar-brand-menu icon-button is-size-s"
          appearance="plain"
          size="s"
          aria-label=${model.commandsLabel}
          title=${model.commandsLabel}
          @click=${callbacks.onSearch}
        >
          ${waIcon('chevron-down')}
        </wa-button>
      </header>

      <nav class="task-sidebar-primary" aria-label="Task actions">
        ${sidebarAction({
          icon: 'pencil',
          label: 'New task',
          onClick: callbacks.onNewTask,
          primary: true,
        })}
        ${sidebarAction({
          icon: 'magnifying-glass',
          label: 'Search',
          onClick: callbacks.onSearch,
        })}
      </nav>

      <div class="task-sidebar-scroll">${papersBody}</div>

      <footer class="task-sidebar-footer">
        ${sidebarAction({
          icon: 'terminal',
          label: 'Terminal',
          onClick: callbacks.onOpenTerminal,
        })}
        ${sidebarAction({
          icon: 'globe',
          label: 'Browser',
          onClick: callbacks.onOpenBrowser,
        })}
        ${sidebarAction({
          icon: 'file-lines',
          label: 'Logs',
          onClick: callbacks.onOpenLogs,
        })}
        ${sidebarAction({
          icon: 'gear',
          label: 'Settings',
          onClick: callbacks.onOpenSettings,
        })}
      </footer>
    </aside>
  `;
}

/**
 * The paper chip at the head of the conversation pane: names the paper the
 * conversation belongs to and switches paper from its menu, the same choice
 * a rail row makes.
 */
export function paperChipTemplate(
  papers: readonly RailPaper[],
  active: RailPaper | undefined,
  onSelectPaper: (key: string) => void,
): TemplateResult {
  return html`
    <wa-dropdown
      class="task-paper-chip"
      placement="bottom-start"
      @wa-select=${(
        event: CustomEvent<{ item: HTMLElement & { value?: string } }>,
      ) => {
        if (event.detail.item.value) onSelectPaper(event.detail.item.value);
      }}
    >
      <wa-button
        slot="trigger"
        type="button"
        appearance="outlined"
        size="s"
        with-caret
        title=${active?.display.key ?? 'No paper open'}
      >
        <span class="task-project-mark icon-surface is-size-s" slot="start"
          >${active?.display.initials ?? 'TX'}</span
        >
        ${active?.display.name ?? 'No paper open'}
      </wa-button>
      ${papers.map(
        (paper) => html`
          <wa-dropdown-item
            value=${paper.display.key}
            type="checkbox"
            ?checked=${paper === active}
            >${paper.display.name}</wa-dropdown-item
          >
        `,
      )}
    </wa-dropdown>
  `;
}

/**
 * The dock under the composer: the paper-level shortcut a running
 * conversation reaches for, dispatched as the surface arm it is. The
 * latexdiff chip opens the Tools sheet on the launcher's base file and
 * commit; the desktop host performs its commit verbs (desktopHostRequests).
 */
export function conversationDockTemplate(): TemplateResult {
  return html`
    <div class="task-conversation-dock" role="group" aria-label="Paper actions">
      <wa-button
        type="button"
        appearance="outlined"
        size="s"
        @click=${(event: Event) =>
          event.target?.dispatchEvent(
            SessionUiEvents.surface({ kind: 'toolsSheet', open: true }),
          )}
      >
        ${waIcon('code-compare', { slot: 'start' })} latexdiff vs last commit
      </wa-button>
    </div>
  `;
}

interface WorkbenchTabsCallbacks {
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
  onHide(): void;
  onMove(tabId: string, placement: WorkbenchPlacement): void;
}

/** DOM id of one tab's activate button; the tabpanel references it via aria-labelledby. */
export function workbenchTabDomId(tabId: string, session = ''): string {
  return `task-workbench-tab-${session}-${tabId}`;
}

/** DOM id of the single pane a placement's tab strip switches. */
export function workbenchPanelDomId(
  placement: WorkbenchPlacement,
  session = '',
): string {
  return `task-workbench-panel-${session}-${placement}`;
}

/** Moves focus to a tab's activate button within its tab strip. */
function focusTabButton(tablist: HTMLElement, tabId: string): void {
  for (const tab of tablist.querySelectorAll('.task-workbench-tab')) {
    if ((tab as HTMLElement).dataset.tabId === tabId) {
      tab.querySelector<HTMLElement>('.task-workbench-tab-activate')?.focus();
      return;
    }
  }
}

/**
 * APG tab-strip keyboard support: ArrowLeft/ArrowRight move between tabs
 * (wrapping), Home/End jump to the ends. Activation is automatic — the pane
 * surfaces stay mounted, so switching is instant and focus stays on the tab.
 * Only keys from a tab itself are handled; the close button and context menu
 * keep their own key behavior.
 */
function handleTablistKeydown(
  event: KeyboardEvent,
  tabs: readonly WorkbenchTab[],
  activeTabId: string | undefined,
  callbacks: WorkbenchTabsCallbacks,
): void {
  if (
    (event.target as HTMLElement | null)?.closest(
      '.task-workbench-tab-activate',
    ) == null
  ) {
    return;
  }
  if (tabs.length === 0) return;
  const currentIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );
  let nextIndex: number;
  switch (event.key) {
    case 'ArrowRight':
      nextIndex = (currentIndex + 1) % tabs.length;
      break;
    case 'ArrowLeft':
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = tabs.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const next = tabs[nextIndex];
  if (!next) return;
  callbacks.onActivate(next.id);
  // onActivate re-renders synchronously, so the strip is already patched when
  // focus moves to the now-active tab.
  focusTabButton(event.currentTarget as HTMLElement, next.id);
}

interface ContextMenuDropdown extends HTMLElement {
  open: boolean;
}

function openTabContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const tab = event.currentTarget as HTMLElement;
  const dropdown = tab.querySelector<ContextMenuDropdown>(
    '.task-workbench-tab-menu',
  );
  const anchor = tab.querySelector<HTMLElement>(
    '.task-workbench-tab-menu-anchor',
  );
  if (!dropdown || !anchor) return;
  anchor.style.setProperty('--context-menu-x', `${event.clientX}px`);
  anchor.style.setProperty('--context-menu-y', `${event.clientY}px`);
  dropdown.open = true;
}

function handleTabMenuSelect(
  event: CustomEvent<{ item: HTMLElement & { value?: string } }>,
  tabId: string,
  callbacks: WorkbenchTabsCallbacks,
): void {
  switch (event.detail.item.value) {
    case 'close':
      callbacks.onClose(tabId);
      break;
    case 'move-bottom':
      callbacks.onMove(tabId, 'bottom');
      break;
    case 'move-right':
      callbacks.onMove(tabId, 'right');
      break;
  }
}

export function workbenchTabsTemplate(
  tabs: readonly WorkbenchTab[],
  activeTabId: string | undefined,
  placement: WorkbenchPlacement,
  callbacks: WorkbenchTabsCallbacks,
  session = '',
): TemplateResult {
  const hideDirection =
    placement === 'right' ? 'chevron-right' : 'chevron-down';
  return html`
    <div
      class="task-workbench-tabs"
      role="tablist"
      aria-label=${`${placement} workbench tabs`}
      @keydown=${(event: KeyboardEvent) =>
        handleTablistKeydown(event, tabs, activeTabId, callbacks)}
    >
      <div class="task-workbench-tabs-scroll">
        ${tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return html`
            <div
              class="task-workbench-tab"
              data-active=${active ? 'true' : 'false'}
              data-kind=${tab.kind}
              data-tab-id=${tab.id}
              @contextmenu=${openTabContextMenu}
            >
              <wa-button
                type="button"
                class="task-workbench-tab-activate"
                appearance="plain"
                size="s"
                role="tab"
                id=${workbenchTabDomId(tab.id, session)}
                aria-selected=${active ? 'true' : 'false'}
                aria-controls=${workbenchPanelDomId(placement, session)}
                tabindex=${active ? '0' : '-1'}
                title=${tab.target ?? tab.title}
                @click=${() => callbacks.onActivate(tab.id)}
              >
                ${waIcon(WORKBENCH_KIND_META[tab.kind].icon, {
                  className: 'task-workbench-tab-icon',
                  slot: 'start',
                })}
                <span class="task-workbench-tab-label">${tab.title}</span>
                ${
                  tab.dirty
                    ? html`<span
                        class="task-workbench-tab-dirty"
                        slot="end"
                        role="img"
                        aria-label="Unsaved changes"
                      ></span>`
                    : nothing
                }
              </wa-button>
              <wa-button
                type="button"
                class="task-workbench-tab-close icon-button is-size-s focus-ring-inset"
                appearance="plain"
                size="s"
                aria-label=${`Close ${tab.title}`}
                title=${`Close ${tab.title}`}
                @click=${(event: MouseEvent) => {
                  event.stopPropagation();
                  callbacks.onClose(tab.id);
                }}
              >
                ${waIcon('xmark')}
              </wa-button>
              <wa-dropdown
                class="task-workbench-tab-menu"
                placement="bottom-start"
                @wa-select=${(
                  event: CustomEvent<{
                    item: HTMLElement & { value?: string };
                  }>,
                ) => handleTabMenuSelect(event, tab.id, callbacks)}
              >
                <button
                  slot="trigger"
                  type="button"
                  class="task-workbench-tab-menu-anchor"
                  tabindex="-1"
                  aria-hidden="true"
                ></button>
                <wa-dropdown-item value="close">
                  ${waIcon('xmark', { slot: 'icon' })} Close
                </wa-dropdown-item>
                <wa-dropdown-item
                  value="move-bottom"
                  ?disabled=${placement === 'bottom'}
                >
                  ${waIcon('window-maximize', { slot: 'icon' })} Move to Bottom
                </wa-dropdown-item>
                <wa-dropdown-item
                  value="move-right"
                  ?disabled=${placement === 'right'}
                >
                  ${waIcon('picture-in-picture', { slot: 'icon' })} Move to
                  Right
                </wa-dropdown-item>
              </wa-dropdown>
            </div>
          `;
        })}
      </div>
      <wa-button
        type="button"
        class="task-workbench-close icon-button is-size-m focus-ring-inset"
        appearance="plain"
        size="s"
        aria-label=${`Hide ${placement} panel`}
        title=${`Hide ${placement} panel`}
        @click=${callbacks.onHide}
      >
        ${waIcon(hideDirection)}
      </wa-button>
    </div>
  `;
}
