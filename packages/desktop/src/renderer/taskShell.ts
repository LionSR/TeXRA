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
import '@awesome.me/webawesome/dist/components/split-panel/split-panel.js';
import { html, nothing, type TemplateResult } from 'lit';

import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import {
  WORKBENCH_KIND_META,
  type WorkbenchPlacement,
  type WorkbenchTab,
} from '../shared/desktopTaskShell.js';

export interface TaskSidebarModel {
  readonly files: Node;
  readonly filesExpanded: boolean;
  readonly hasWorkspace: boolean;
  readonly initials: string;
  readonly projectSectionPosition: number;
  readonly sessions: Node;
  readonly streamCount: number;
  readonly workspaceName: string;
  readonly workspacePath?: string;
  /** Canonical name of the command palette action, from the command catalog. */
  readonly commandsLabel: string;
}

export interface TaskSidebarCallbacks {
  onNewTask(): void;
  onSearch(): void;
  onToggleFiles(): void;
  onOpenFolder(): void;
  onOpenTerminal(): void;
  onOpenBrowser(): void;
  onOpenSettings(): void;
  onOpenLogs(): void;
  onResizeProjectSection(event: Event): void;
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

export function taskSidebarTemplate(
  model: TaskSidebarModel,
  callbacks: TaskSidebarCallbacks,
): TemplateResult {
  let projectDisclosureIcon: TeXRAIconName = 'arrow-up-right-from-square';
  if (model.hasWorkspace) {
    projectDisclosureIcon = model.filesExpanded
      ? 'chevron-down'
      : 'chevron-right';
  }

  // The nested split panel can connect before its slotted parent has a height.
  // Web Awesome recovers its pixel position from this attribute after resize.
  return html`
    <aside class="task-sidebar" aria-label="Projects and tasks">
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

      <wa-split-panel
        class="task-sidebar-scroll"
        orientation="vertical"
        position=${model.projectSectionPosition}
        @wa-reposition=${callbacks.onResizeProjectSection}
      >
        <span slot="divider" class="task-section-split-handle">
          ${waIcon('ellipsis')}
        </span>
        <section slot="start" class="task-sidebar-section task-project-section">
          <div class="task-sidebar-section-label">Project</div>
          <wa-button
            type="button"
            class="task-project-row btn-ghost"
            appearance="plain"
            size="s"
            title=${model.workspacePath ?? 'Open a project folder'}
            @click=${
              model.hasWorkspace
                ? callbacks.onToggleFiles
                : callbacks.onOpenFolder
            }
          >
            <span class="task-project-mark icon-surface is-size-m">
              ${model.initials}
            </span>
            <span class="task-project-copy">
              <strong>${model.workspaceName}</strong>
              <small
                >${model.hasWorkspace ? 'Local workspace' : 'Get started'}</small
              >
            </span>
            ${waIcon(projectDisclosureIcon, {
              className: 'task-project-chevron',
              slot: 'end',
            })}
          </wa-button>
          <div class="task-project-files" ?hidden=${!model.filesExpanded}>
            ${model.files}
          </div>
        </section>

        <section slot="end" class="task-sidebar-section task-history-section">
          <div class="task-sidebar-section-heading">
            <span class="task-sidebar-section-label">Tasks</span>
            <wa-badge
              class="task-sidebar-section-count"
              variant="neutral"
              appearance="outlined"
              pill
              >${model.streamCount}</wa-badge
            >
          </div>
          <div class="task-sidebar-sessions">${model.sessions}</div>
        </section>
      </wa-split-panel>

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

export interface WorkbenchTabsCallbacks {
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
  onHide(): void;
  onMove(tabId: string, placement: WorkbenchPlacement): void;
}

/** DOM id of one tab's activate button; the tabpanel references it via aria-labelledby. */
export function workbenchTabDomId(tabId: string): string {
  return `task-workbench-tab-${tabId}`;
}

/** DOM id of the single pane a placement's tab strip switches. */
export function workbenchPanelDomId(placement: WorkbenchPlacement): string {
  return `task-workbench-panel-${placement}`;
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
                id=${workbenchTabDomId(tab.id)}
                aria-selected=${active ? 'true' : 'false'}
                aria-controls=${workbenchPanelDomId(placement)}
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
