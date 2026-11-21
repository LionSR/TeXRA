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

import type { SessionView } from '@texra-ai/harness/schemas';
import {
  projectName,
  type ProjectDisplay,
} from '@texra/shared/session/hostSnapshot';
import type { Surface } from '@texra/shared/session/surface';
import { unseenRuns } from '@texra/shared/session/unseenRuns';
import {
  runSectionTone,
  sectionCountLabel,
  type RunTone,
} from '@ui/copy/runStatus';
import { EMPTY_TASK_LIST } from '@ui/copy/nestedRuns';
import type { IconName } from '@ui/wa/iconNames';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { actionMenu } from '@ui/wa/actionMenu';
import { renderEmptyMessage } from '@ui/wa/emptyState';
import { inlineRenameField } from '@ui/wa/inlineRename';
import { waIcon } from '@ui/wa/webAwesomeIcons';
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

/** Project menu actions always name the project they affect. */
type ProjectAction = 'new-task' | 'rename' | 'close';

interface ShellSidebarCallbacks {
  onNewTask(): void;
  onOpenCommands(): void;
  onOpenFolder(): void;
  onOpenRecent(root: string): void;
  onSelectProject(key: string): void;
  onProjectAction(key: string, action: ProjectAction): void;
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

/** The run sections a project's status names, in the order it names them. */
const RAIL_SECTIONS = ['waiting', 'interrupted', 'running'] as const;

/**
 * A project's one status, read from its view's rollup and its surface: what
 * needs the user first (waiting, then interrupted), then work in progress,
 * then runs that finished while the user was elsewhere. The first three are
 * run sections, worded and toned as the run list words them; unseen is the
 * rail's own.
 */
function projectStatus(
  project: RailProject,
): { readonly tone: RunTone | 'unseen'; readonly label: string } | undefined {
  const { rollup } = project.view;
  const section = RAIL_SECTIONS.find((key) => rollup[key] > 0);
  if (section !== undefined)
    return {
      tone: runSectionTone(section),
      label: sectionCountLabel(section, String(rollup[section])),
    };
  const unseen = unseenRuns(project.surface, project.view).size;
  if (unseen > 0) return { tone: 'unseen', label: `${unseen} finished` };
  return undefined;
}

/** Project selection is separate from the active project's task history. */
function projectSection(
  project: RailProject,
  model: ShellSidebarModel,
  callbacks: ShellSidebarCallbacks,
): TemplateResult {
  const { key, name } = project.display;
  const active = key === model.shell.active;
  // Tooltip anchors: the key is a path, so it is encoded into the DOM id.
  const idBase = `shell-project-${encodeURIComponent(key)}`;
  const status = projectStatus(project);
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
    <div class="shell-project-item ${active ? 'is-active' : ''}">
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
          : html`<wa-button
              type="button"
              class="shell-project-row btn-ghost is-row is-row-content"
              appearance="plain"
              size="s"
              title=${key}
              aria-current=${active ? 'true' : nothing}
              @click=${() => callbacks.onSelectProject(key)}
              @dblclick=${() => callbacks.onProjectAction(key, 'rename')}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === 'F2') {
                  event.preventDefault();
                  callbacks.onProjectAction(key, 'rename');
                }
              }}
            >
              ${waIcon('folder', { slot: 'start' })}<span
                class="shell-project-name"
                >${name}</span
              >
            </wa-button>`
      }
      ${
        // The dot is the row's whole status line; its words are the tooltip.
        status
          ? html`<span
              class="shell-project-status status-dot tone-${status.tone}"
              role="img"
              aria-label=${status.label}
              title=${status.label}
            ></span>`
          : nothing
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
  `;
}

export function shellSidebarTemplate(
  model: ShellSidebarModel,
  callbacks: ShellSidebarCallbacks,
): TemplateResult {
  const active = model.projects.find(
    (project) => project.display.key === model.shell.active,
  );
  return html`
    <aside class="shell-sidebar" aria-label="Projects and tasks">
      <nav class="shell-sidebar-primary" aria-label="Task actions">
        ${sidebarAction({
          icon: 'magnifying-glass',
          label: model.commandsLabel,
          title: model.commandsTitle,
          onClick: callbacks.onOpenCommands,
        })}
      </nav>
      <div class="shell-sidebar-scroll">
        <section
          class="shell-sidebar-section shell-project-section"
          aria-label="Open projects"
        >
          <div class="shell-sidebar-section-heading">
            <span class="shell-sidebar-section-label">Projects</span>
            ${renderIconActionButton({
              id: 'shellProjectAdd',
              icon: 'folder-open',
              label: 'Open project folder',
              tooltip: 'Open project folder',
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
        <section
          class="shell-sidebar-section shell-history-section"
          aria-label="Task history"
        >
          <div class="shell-sidebar-section-heading">
            <span class="shell-sidebar-section-label">Task history</span>
            ${renderLabeledActionButton({
              id: 'shellNewTask',
              icon: 'plus',
              text: 'New task',
              kind: 'ghost',
              className: 'is-compact',
              onClick: callbacks.onNewTask,
            })}
          </div>
          ${
            active && active.view.order.length > 0
              ? html` <div
                  class="shell-sidebar-sessions shell-project-runs"
                  data-session=${active.display.key}
                >
                  <run-tabs
                    .view=${active.view}
                    .surface=${active.surface}
                    .topLevelOnly=${true}
                    removable
                  ></run-tabs>
                </div>`
              : renderEmptyMessage(EMPTY_TASK_LIST.body)
          }
        </section>
      </div>
      <footer class="shell-sidebar-footer">
        ${sidebarAction({ icon: 'gear', label: 'Settings', onClick: callbacks.onOpenSettings })}
      </footer>
    </aside>
  `;
}
