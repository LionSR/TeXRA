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

import type { SessionView } from '@texra-ai/worldline/schemas';
import {
  projectName,
  type PlanUsage,
  type ProjectDisplay,
} from '@texra/shared/session/hostSnapshot';
import type { Surface } from '@texra/shared/session/surface';
import type { IconName } from '@ui/wa/iconNames';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { actionMenu } from '@ui/wa/actionMenu';
import { inlineRenameField } from '@ui/wa/inlineRename';
import '@ui/progress/components/PlanUsageMeters';
import {
  DESKTOP_LOCAL_COMMANDS,
  desktopCommandEntry,
} from '../shared/desktopCommandSurface';
import type { Shell } from './shell';

/** One open project as the rail lists it: how its host names it, its session,
 *  its surface. */
export interface RailProject {
  readonly display: ProjectDisplay;
  readonly view: SessionView;
  readonly surface: Surface;
}

interface ShellSidebarModel {
  readonly renamingProjectKey?: string | null;
  /** Every open project, in `shell.open` order. */
  readonly projects: readonly RailProject[];
  /** Folders of recently closed projects, the most recent first: offered
   *  under "Open a project" while no project is open. */
  readonly recent: readonly string[];
  readonly shell: Shell;
  /** Canonical name of the command palette action, from the command catalog. */
  readonly commandsLabel: string;
  /** The same name with its shortcut, for the tooltip. */
  readonly commandsTitle: string;
}

/** The recent projects the empty rail offers; File › Open Recent has all. */
const RECENT_PROJECTS_SHOWN = 5;
const OPEN_FOLDER_TITLE = desktopCommandEntry(
  DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
).title;

/** Project menu actions always name the project they affect. */
type ProjectAction = 'new-task' | 'rename' | 'close';

interface ShellSidebarCallbacks {
  onNewTask(): void;
  onOpenCommands(): void;
  onOpenFolder(): void;
  onOpenRecent(root: string): void;
  onSelectProject(key: string): void;
  onProjectAction(key: string, action: ProjectAction): void;
  /** Show or hide a project's tasks. */
  onToggleProject(key: string): void;
  onRenameProject?(key: string, name: string): void;
  onCloseRename?(): void;
  onOpenSettings(): void;
}

function sidebarAction(options: {
  icon: IconName;
  label: string;
  title?: string;
  onClick: () => void;
}): TemplateResult {
  return renderLabeledActionButton({
    icon: options.icon,
    text: options.label,
    title: options.title,
    kind: 'ghost',
    className: 'shell-sidebar-action is-row',
    onClick: options.onClick,
  });
}

/** The project row's own button: the menu and the rename field beside it
 *  answer neither a double-click nor F2. */
function onProjectRow(event: Event): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest('wa-button.shell-project-row') !== null
  );
}

/**
 * One project: its row, and its tasks under it. Collapsed, it still lists
 * the tasks that are running or need the person, so nothing that wants
 * attention is behind a closed row.
 */
function projectSection(
  project: RailProject,
  model: ShellSidebarModel,
  callbacks: ShellSidebarCallbacks,
): TemplateResult {
  const { key, name } = project.display;
  const active = key === model.shell.active;
  // Tooltip anchors: the key is a path, so it is encoded into the DOM id.
  const idBase = `shell-project-${encodeURIComponent(key)}`;
  const collapsed = model.shell.collapsed.includes(key);
  const hasTasks = project.view.order.length > 0;
  const menu = actionMenu([
    {
      icon: 'plus',
      label: 'New task',
      activate: () => callbacks.onProjectAction(key, 'new-task'),
    },
    {
      icon: 'pencil',
      label: 'Rename project…',
      focusesOwn: true,
      activate: () => callbacks.onProjectAction(key, 'rename'),
    },
    {
      icon: 'xmark',
      label: 'Close project',
      activate: () => callbacks.onProjectAction(key, 'close'),
    },
  ]);
  return html`
    <div
      class="shell-project-item ${active ? 'is-active' : ''}"
      @dblclick=${(event: MouseEvent) => {
        if (onProjectRow(event)) callbacks.onProjectAction(key, 'rename');
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key !== 'F2' || !onProjectRow(event)) return;
        event.preventDefault();
        callbacks.onProjectAction(key, 'rename');
      }}
    >
      ${renderIconActionButton({
        id: `${idBase}-toggle`,
        icon: collapsed ? 'folder' : 'folder-open',
        label: collapsed ? `Show ${name}'s tasks` : `Hide ${name}'s tasks`,
        className: 'shell-project-toggle',
        onClick: () => callbacks.onToggleProject(key),
      })}
      ${
        model.renamingProjectKey === key
          ? inlineRenameField({
              value: name,
              label: 'Project display name',
              className: 'shell-project-row shell-project-rename',
              maxLength: 80,
              onRename: (value) => callbacks.onRenameProject?.(key, value),
              onClose: () => callbacks.onCloseRename?.(),
            })
          : renderLabeledActionButton({
              kind: 'ghost',
              className: 'shell-project-row is-row is-row-content',
              // prettier-ignore
              text: html`<span class="shell-project-name truncate">${name}</span>`,
              title: key,
              current: active,
              onClick: () => callbacks.onSelectProject(key),
            })
      }
      <wa-dropdown
        class="shell-project-menu"
        placement="bottom-end"
        @wa-select=${menu.onSelect}
      >
        ${renderIconActionButton({
          id: `${idBase}-menu`,
          icon: 'ellipsis',
          slot: 'trigger',
          label: `Actions for ${name}`,
          tooltip: `Actions for ${name}`,
        })}
        ${menu.items}
      </wa-dropdown>
    </div>
    ${
      hasTasks
        ? html`<div
            class="shell-sidebar-sessions shell-project-runs ${
              active ? 'is-active' : ''
            }"
            data-session=${key}
          >
            <run-tabs
              .view=${project.view}
              .surface=${project.surface}
              ?activeOnly=${collapsed}
              removable
            ></run-tabs>
          </div>`
        : nothing
    }
  `;
}

export function shellSidebarTemplate(
  model: ShellSidebarModel,
  callbacks: ShellSidebarCallbacks,
): TemplateResult {
  return html`
    <aside class="shell-sidebar" aria-label="Projects and tasks">
      <nav class="shell-sidebar-primary" aria-label="Quick actions">
        ${renderLabeledActionButton({
          id: 'shellCommands',
          icon: 'magnifying-glass',
          text: 'Search',
          title: model.commandsTitle,
          kind: 'ghost',
          className: 'shell-sidebar-search is-row',
          onClick: callbacks.onOpenCommands,
        })}
        ${renderLabeledActionButton({
          id: 'shellNewTask',
          icon: 'plus',
          text: desktopCommandEntry('texra.showMainView').title,
          kind: 'ghost',
          className: 'shell-sidebar-action is-row',
          onClick: callbacks.onNewTask,
        })}
      </nav>
      <div class="shell-sidebar-scroll">
        <section
          class="shell-sidebar-section shell-project-section"
          aria-label="Open projects"
        >
          <div class="shell-sidebar-section-heading">
            <span class="overline">Projects</span>
            ${renderIconActionButton({
              id: 'shellProjectAdd',
              icon: 'plus',
              label: OPEN_FOLDER_TITLE,
              tooltip: OPEN_FOLDER_TITLE,
              className: 'shell-project-add',
              onClick: callbacks.onOpenFolder,
            })}
          </div>
          ${
            model.projects.length === 0
              ? html`${sidebarAction({
                  icon: 'folder-open',
                  label: 'Open a project',
                  onClick: callbacks.onOpenFolder,
                })}
                ${model.recent.slice(0, RECENT_PROJECTS_SHOWN).map((root) =>
                  sidebarAction({
                    icon: 'clock-rotate-left',
                    label: projectName(root),
                    title: `Reopen ${root}`,
                    onClick: () => callbacks.onOpenRecent(root),
                  }),
                )}`
              : model.projects.map((project) =>
                  projectSection(project, model, callbacks),
                )
          }
        </section>
      </div>
      <footer class="shell-sidebar-footer">
        ${renderIconActionButton({
          id: 'shellSettings',
          icon: 'gear',
          label: 'Settings',
          tooltip: 'Settings',
          onClick: callbacks.onOpenSettings,
        })}
      </footer>
    </aside>
  `;
}

/**
 * The window's status bar: the subscription meters of the shown project,
 * and nothing where no plan states a quota. `data-session` names that
 * project, so a request the meters send (a refresh, the settings page) goes
 * to its session.
 */
export function shellStatusBarTemplate(model: {
  readonly active: string;
  readonly planUsage: readonly PlanUsage[];
}): TemplateResult | typeof nothing {
  if (model.planUsage.length === 0) return nothing;
  return html`
    <footer
      class="shell-statusbar"
      aria-label="Status"
      data-session=${model.active}
    >
      <plan-usage-meters .usage=${model.planUsage}></plan-usage-meters>
    </footer>
  `;
}
