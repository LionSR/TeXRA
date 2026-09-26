// Templates for the conversation-first desktop chrome.
//
// These templates intentionally contain no state. The renderer owns resource
// lifecycles and passes callbacks here, while desktopShellState.ts owns the pure
// reducer. Keeping the markup separate makes main.ts a composition module
// instead of a second UI component.

import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import { html, nothing, type TemplateResult } from 'lit';

import type { ProjectDisplay } from '@shared/session/hostSnapshot';
import type { SessionView } from '@shared/session/sessionView';
import type { Shell } from '@shared/session/shell';
import type { Surface } from '@shared/session/surface';
import { unseenRuns } from '@shared/session/unseenRuns';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import type { TeXRAIconName } from '@ui/wa/iconNames';
import { nextTablistIndex } from '@ui/wa/tablistKeyboardNav';
import { waIcon } from '@ui/wa/webAwesomeIcons';

import {
  WORKBENCH_KIND_META,
  type WorkbenchPlacement,
  type WorkbenchTab,
} from '../shared/desktopShellState.js';

/** One open project as the rail lists it: how its host names it, its session,
 *  its surface. */
export interface RailProject {
  readonly display: ProjectDisplay;
  readonly view: SessionView;
  readonly surface: Surface;
}

interface ShellSidebarModel {
  /** Every open project, in `shell.open` order. */
  readonly projects: readonly RailProject[];
  readonly shell: Shell;
  /** Canonical name of the command palette action, from the command catalog. */
  readonly commandsLabel: string;
  /** The same name with its shortcut, for the tooltip. */
  readonly commandsTitle: string;
}

/** What a project row's `⋯` menu and `+` do; each names the project. */
type ProjectAction = 'new-task' | 'close';

interface ShellSidebarCallbacks {
  onNewTask(): void;
  onOpenCommands(): void;
  onOpenFolder(): void;
  onSelectProject(key: string): void;
  onProjectAction(key: string, action: ProjectAction): void;
  onToggleProjectCollapsed(key: string): void;
  onOpenSettings(): void;
}

function sidebarAction(options: {
  icon: TeXRAIconName;
  label: string;
  title?: string;
  onClick: () => void;
}): TemplateResult {
  return html`
    <wa-button
      type="button"
      class="shell-sidebar-action btn-ghost"
      appearance="plain"
      size="s"
      title=${options.title ?? nothing}
      @click=${options.onClick}
    >
      ${waIcon(options.icon, {
        className: 'shell-sidebar-action-icon',
        slot: 'start',
      })}
      <span>${options.label}</span>
    </wa-button>
  `;
}

/**
 * A project's one status, read from its view's rollup and its surface: what
 * needs the user first (waiting, then interrupted), then work in progress,
 * then runs that finished while the user was elsewhere.
 */
function projectStatus(
  project: RailProject,
): { readonly tone: string; readonly label: string } | undefined {
  const { waiting, interrupted, running } = project.view.rollup;
  if (waiting > 0)
    return { tone: 'waiting', label: `${waiting} waiting for you` };
  if (interrupted > 0)
    return { tone: 'interrupted', label: `${interrupted} interrupted` };
  if (running > 0) return { tone: 'running', label: `${running} running` };
  const unseen = unseenRuns(project.surface, project.view).size;
  if (unseen > 0) return { tone: 'unseen', label: `${unseen} finished` };
  return undefined;
}

/**
 * One section per open project: the row, then that project's conversations
 * (its top-level runs; a run's subagents live in the Subagents tab) unless
 * the user folded the section shut. Every row has the same controls, so the
 * shown project differs only by its highlight: the row chooses the project,
 * `+` starts a task in it, and `×` closes it.
 */
function projectSection(
  project: RailProject,
  model: ShellSidebarModel,
  callbacks: ShellSidebarCallbacks,
): TemplateResult {
  const { key, name, initials } = project.display;
  const active = key === model.shell.active;
  const collapsed = model.shell.collapsed.includes(key);
  const foldLabel = `${collapsed ? 'Expand' : 'Collapse'} ${name}`;
  // Tooltip anchors: the key is a path, so it is encoded into the DOM id.
  const idBase = `shell-project-${encodeURIComponent(key)}`;
  const status = projectStatus(project);
  return html`
    <div class="shell-project-item ${active ? 'is-active' : ''}">
      ${renderIconActionButton({
        id: `${idBase}-fold`,
        icon: collapsed ? 'chevron-right' : 'chevron-down',
        label: foldLabel,
        tooltip: foldLabel,
        expanded: !collapsed,
        className: 'shell-project-fold icon-button is-size-s',
        onClick: () => callbacks.onToggleProjectCollapsed(key),
      })}
      <wa-button
        type="button"
        class="shell-project-row btn-ghost"
        appearance="plain"
        size="s"
        title=${key}
        aria-current=${active ? 'true' : nothing}
        @click=${() => callbacks.onSelectProject(key)}
      >
        <span class="shell-project-mark icon-surface is-size-m"
          >${initials}</span
        >
        <span class="shell-project-copy">
          <strong>${name}</strong>
          ${status ? html`<small>${status.label}</small>` : nothing}
        </span>
      </wa-button>
      ${
        status
          ? html`<span
              class="shell-project-status"
              data-tone=${status.tone}
              role="img"
              aria-label=${status.label}
            ></span>`
          : nothing
      }
      ${renderIconActionButton({
        id: `${idBase}-new`,
        icon: 'plus',
        label: `New task in ${name}`,
        tooltip: `New task in ${name}`,
        className: 'shell-project-new icon-button is-size-s',
        onClick: () => callbacks.onProjectAction(key, 'new-task'),
      })}
      ${renderIconActionButton({
        id: `${idBase}-close`,
        icon: 'xmark',
        label: `Close ${name}`,
        tooltip: `Close ${name}`,
        className: 'shell-project-close icon-button is-size-s',
        onClick: () => callbacks.onProjectAction(key, 'close'),
      })}
    </div>
    ${
      // An empty project lists nothing: its `+` is the way to start.
      collapsed || project.view.order.length === 0
        ? nothing
        : html`<div
            class="shell-sidebar-sessions shell-project-runs"
            data-session=${key}
          >
            <run-tabs
              .view=${project.view}
              .surface=${project.surface}
              .topLevelOnly=${true}
            ></run-tabs>
          </div>`
    }
  `;
}

export function shellSidebarTemplate(
  model: ShellSidebarModel,
  callbacks: ShellSidebarCallbacks,
): TemplateResult {
  return html`
    <aside class="shell-sidebar" aria-label="Projects and tasks">
      <header class="shell-sidebar-brand">
        <div class="shell-sidebar-logo" aria-hidden="true"></div>
        <span class="shell-sidebar-product">TeXRA</span>
      </header>

      <nav class="shell-sidebar-primary" aria-label="Task actions">
        ${sidebarAction({
          icon: 'pencil',
          label: 'New task',
          onClick: callbacks.onNewTask,
        })}
        ${sidebarAction({
          icon: 'magnifying-glass',
          label: model.commandsLabel,
          title: model.commandsTitle,
          onClick: callbacks.onOpenCommands,
        })}
      </nav>

      <div class="shell-sidebar-scroll">
        <section class="shell-sidebar-section shell-project-section">
          <div class="shell-sidebar-section-heading">
            <span class="shell-sidebar-section-label">Projects</span>
            ${renderIconActionButton({
              id: 'shellProjectAdd',
              icon: 'folder-open',
              label: 'Open project folder',
              tooltip: 'Open project folder',
              className: 'shell-project-add icon-button is-size-s',
              onClick: callbacks.onOpenFolder,
            })}
          </div>
          ${
            model.projects.length === 0
              ? html`<wa-button
                  type="button"
                  class="shell-project-empty btn-ghost"
                  appearance="plain"
                  size="s"
                  @click=${callbacks.onOpenFolder}
                >
                  ${waIcon('folder-open', { slot: 'start' })}
                  <span>Open a project folder</span>
                </wa-button>`
              : model.projects.map((project) =>
                  projectSection(project, model, callbacks),
                )
          }
        </section>
      </div>

      <footer class="shell-sidebar-footer">
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
 * The way into the selected conversation's subagents: the Subagents tab
 * holds the tree, so this only opens it. Nothing when the conversation has
 * no children.
 */
export function subagentsButtonTemplate(
  project: RailProject | undefined,
  onOpen: () => void,
): TemplateResult | typeof nothing {
  if (!project) return nothing;
  const { selected } = project.surface;
  const run = selected === null ? undefined : project.view.runs.get(selected);
  const rootId = run?.ancestors[0]?.id ?? run?.id;
  const root = rootId === undefined ? undefined : project.view.runs.get(rootId);
  if (root === undefined || root.rollup.total === 0) return nothing;
  const { icon, label } = WORKBENCH_KIND_META.subagents;
  return html`
    <wa-button
      type="button"
      class="shell-subagents-open btn-secondary"
      appearance="outlined"
      size="s"
      title="Show this task's subagents"
      @click=${onOpen}
    >
      ${waIcon(icon, { slot: 'start' })}
      <span>${label}</span>
      <span class="shell-subagents-open-count" slot="end"
        >${root.rollup.total}</span
      >
    </wa-button>
  `;
}

interface WorkbenchTabsCallbacks {
  /** The strip's `+`: open a tool surface in this pane. */
  onOpenKind(kind: 'files' | 'terminal' | 'browser' | 'logs'): void;
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
  onHide(): void;
  onMove(tabId: string, placement: WorkbenchPlacement): void;
}

/** DOM id of one tab's activate button; the tabpanel references it via aria-labelledby. */
export function workbenchTabDomId(tabId: string, session: string): string {
  return `shell-workbench-tab-${session}-${tabId}`;
}

/** DOM id of the single pane a placement's tab strip switches. */
export function workbenchPanelDomId(
  placement: WorkbenchPlacement,
  session: string,
): string {
  return `shell-workbench-panel-${session}-${placement}`;
}

/** Moves focus to a tab's activate button within its tab strip. */
function focusTabButton(tablist: HTMLElement, tabId: string): void {
  const tab = [
    ...tablist.querySelectorAll<HTMLElement>('.shell-workbench-tab'),
  ].find((candidate) => candidate.dataset.tabId === tabId);
  tab?.querySelector<HTMLElement>('.shell-workbench-tab-activate')?.focus();
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
      '.shell-workbench-tab-activate',
    ) == null
  ) {
    return;
  }
  if (tabs.length === 0) return;
  const currentIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );
  const nextIndex = nextTablistIndex(event.key, currentIndex, tabs.length);
  if (nextIndex === undefined) return;
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
    '.shell-workbench-tab-menu',
  );
  const anchor = tab.querySelector<HTMLElement>(
    '.shell-workbench-tab-menu-anchor',
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
  session: string,
): TemplateResult {
  const hideDirection =
    placement === 'right' ? 'chevron-right' : 'chevron-down';
  return html`
    <div
      class="shell-workbench-tabs"
      role="tablist"
      aria-label=${`${placement === 'right' ? 'Side' : 'Bottom'} panel tabs`}
      @keydown=${(event: KeyboardEvent) =>
        handleTablistKeydown(event, tabs, activeTabId, callbacks)}
    >
      <div class="shell-workbench-tabs-scroll">
        ${tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return html`
            <div
              class="shell-workbench-tab"
              data-active=${active ? 'true' : 'false'}
              data-kind=${tab.kind}
              data-tab-id=${tab.id}
              @contextmenu=${openTabContextMenu}
            >
              <wa-button
                type="button"
                class="shell-workbench-tab-activate"
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
                  className: 'shell-workbench-tab-icon',
                  slot: 'start',
                })}
                <span class="shell-workbench-tab-label">${tab.title}</span>
                ${
                  tab.dirty
                    ? html`<span
                        class="shell-workbench-tab-dirty"
                        slot="end"
                        role="img"
                        aria-label="Unsaved changes"
                      ></span>`
                    : nothing
                }
              </wa-button>
              ${renderIconActionButton({
                id: `${workbenchTabDomId(tab.id, session)}-close`,
                icon: 'xmark',
                label: `Close ${tab.title}`,
                tooltip: `Close ${tab.title}`,
                className:
                  'shell-workbench-tab-close icon-button is-size-s focus-ring-inset',
                onClick: (event) => {
                  event.stopPropagation();
                  callbacks.onClose(tab.id);
                },
              })}
              <wa-dropdown
                class="shell-workbench-tab-menu"
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
                  class="shell-workbench-tab-menu-anchor"
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
      <wa-dropdown
        class="shell-workbench-add"
        placement="bottom-end"
        @wa-select=${(
          event: CustomEvent<{ item: HTMLElement & { value?: string } }>,
        ) => {
          const kind = event.detail.item.value;
          if (
            kind === 'files' ||
            kind === 'terminal' ||
            kind === 'browser' ||
            kind === 'logs'
          )
            callbacks.onOpenKind(kind);
        }}
      >
        <wa-button
          slot="trigger"
          type="button"
          class="shell-workbench-close icon-button focus-ring-inset"
          appearance="plain"
          size="m"
          aria-label="Open a tool"
        >
          ${waIcon('plus')}
        </wa-button>
        ${(['files', 'terminal', 'browser', 'logs'] as const).map(
          (kind) =>
            html`<wa-dropdown-item value=${kind}>
              ${waIcon(WORKBENCH_KIND_META[kind].icon, { slot: 'icon' })}
              ${WORKBENCH_KIND_META[kind].label}
            </wa-dropdown-item>`,
        )}
      </wa-dropdown>
      ${renderIconActionButton({
        id: `${workbenchPanelDomId(placement, session)}-hide`,
        icon: hideDirection,
        label: `Hide ${placement === 'right' ? 'side' : 'bottom'} panel`,
        tooltip: `Hide ${placement === 'right' ? 'side' : 'bottom'} panel`,
        className: 'shell-workbench-close icon-button focus-ring-inset',
        size: 'm',
        onClick: callbacks.onHide,
      })}
    </div>
  `;
}
