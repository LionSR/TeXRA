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
import type { TeXRAIconName } from '@shared/iconNames';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';

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
  readonly shell: Shell;
  /** Canonical name of the command palette action, from the command catalog. */
  readonly commandsLabel: string;
  /** The same name with its shortcut, for the tooltip. */
  readonly commandsTitle: string;
}

/** Project menu actions always name the project they affect. */
type ProjectAction = 'new-task' | 'rename' | 'close';

interface ShellSidebarCallbacks {
  onNewTask(): void;
  onOpenCommands(): void;
  onOpenFolder(): void;
  onSelectProject(key: string): void;
  onProjectAction(key: string, action: ProjectAction): void;
  onRenameProject?(key: string, name: string | null): void;
  onOpenSettings(): void;
}

function sidebarAction(options: {
  icon: TeXRAIconName;
  label: string;
  title?: string;
  emphasized?: boolean;
  onClick: () => void;
}): TemplateResult {
  return html`
    <wa-button
      type="button"
      class="shell-sidebar-action ${options.emphasized ? 'btn-secondary' : 'btn-ghost'}"
      appearance=${options.emphasized ? 'outlined' : 'plain'}
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
  return html`
    <div class="shell-project-item ${active ? 'is-active' : ''}">
      ${
        model.renamingProjectKey === key
          ? html`<input
              class="shell-project-row shell-project-rename inline-rename"
              aria-label="Project display name"
              maxlength="80"
              .value=${name}
              @keydown=${(event: KeyboardEvent) => {
                event.stopPropagation();
                if (event.key === 'Enter')
                  callbacks.onRenameProject?.(
                    key,
                    (event.target as HTMLInputElement).value,
                  );
                if (event.key === 'Escape')
                  callbacks.onRenameProject?.(key, null);
              }}
              @blur=${(event: FocusEvent) => callbacks.onRenameProject?.(key, (event.target as HTMLInputElement).value)}
            />`
          : html`<wa-button
              type="button"
              class="shell-project-row btn-ghost is-row-content"
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
              class="shell-project-status"
              data-tone=${status.tone}
              role="img"
              aria-label=${status.label}
              title=${status.label}
            ></span>`
          : nothing
      }
      <wa-dropdown
        class="shell-project-menu"
        placement="bottom-end"
        @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
          const action = event.detail.item.value;
          if (
            action === 'new-task' ||
            action === 'rename' ||
            action === 'close'
          )
            callbacks.onProjectAction(key, action);
        }}
      >
        ${renderIconActionButton({
          id: `${idBase}-menu`,
          icon: 'ellipsis',
          slot: 'trigger',
          label: `Actions for ${name}`,
          tooltip: `Actions for ${name}`,
        })}
        <wa-dropdown-item value="new-task">
          ${waIcon('plus', { slot: 'icon' })} New task
        </wa-dropdown-item>
        <wa-dropdown-item value="rename">
          ${waIcon('pencil', { slot: 'icon' })} Rename project…
        </wa-dropdown-item>
        <wa-dropdown-item value="close">
          ${waIcon('xmark', { slot: 'icon' })} Close project
        </wa-dropdown-item>
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
              ? sidebarAction({
                  icon: 'folder-open',
                  label: 'Open a project',
                  onClick: callbacks.onOpenFolder,
                })
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
              : html`<p class="shell-history-empty">
                  Your tasks will appear here.
                </p>`
          }
        </section>
      </div>
      <footer class="shell-sidebar-footer">
        ${sidebarAction({ icon: 'gear', label: 'Settings', onClick: callbacks.onOpenSettings })}
      </footer>
    </aside>
  `;
}
