// Templates for the conversation-first desktop chrome.
//
// These templates intentionally contain no state. The renderer owns resource
// lifecycles and passes callbacks here, while desktopTaskShell.ts owns the pure
// reducer. Keeping the markup separate makes main.ts a composition module
// instead of a second UI component.

import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, nothing, type TemplateResult } from 'lit';

import { waIcon } from '@shared/wa/webAwesomeIcons';

import { WORKBENCH_KIND_META, type WorkbenchTab } from '../desktopTaskShell.js';

export interface TaskSidebarModel {
  readonly files: Node;
  readonly filesExpanded: boolean;
  readonly hasWorkspace: boolean;
  readonly initials: string;
  readonly pendingApprovalCount: number;
  readonly sessions: Node;
  readonly streamCount: number;
  readonly workspaceName: string;
  readonly workspacePath?: string;
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
}

function sidebarAction(options: {
  icon: Parameters<typeof waIcon>[0];
  label: string;
  onClick: () => void;
  badge?: number;
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
      ${
        options.badge && options.badge > 0
          ? html`<wa-badge
              class="task-sidebar-badge"
              slot="end"
              variant="warning"
              appearance="filled"
              pill
              >${options.badge > 99 ? '99+' : options.badge}</wa-badge
            >`
          : nothing
      }
    </wa-button>
  `;
}

export function taskSidebarTemplate(
  model: TaskSidebarModel,
  callbacks: TaskSidebarCallbacks,
): TemplateResult {
  let projectDisclosureIcon: Parameters<typeof waIcon>[0] =
    'arrow-up-right-from-square';
  if (model.hasWorkspace) {
    projectDisclosureIcon = model.filesExpanded
      ? 'chevron-down'
      : 'chevron-right';
  }

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
          aria-label="Open commands"
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

      <div class="task-sidebar-scroll">
        <section class="task-sidebar-section task-project-section">
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

        <section class="task-sidebar-section task-history-section">
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
      </div>

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
          badge: model.pendingApprovalCount,
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
  onCloseWorkbench(): void;
}

export function workbenchTabsTemplate(
  tabs: readonly WorkbenchTab[],
  activeTabId: string | undefined,
  callbacks: WorkbenchTabsCallbacks,
): TemplateResult {
  return html`
    <div class="task-workbench-tabs" role="tablist" aria-label="Workbench tabs">
      <div class="task-workbench-tabs-scroll">
        ${tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return html`
            <div
              class="task-workbench-tab"
              data-active=${active ? 'true' : 'false'}
              data-kind=${tab.kind}
            >
              <wa-button
                type="button"
                class="task-workbench-tab-activate"
                appearance="plain"
                size="s"
                role="tab"
                aria-selected=${active ? 'true' : 'false'}
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
            </div>
          `;
        })}
      </div>
      <wa-button
        type="button"
        class="task-workbench-close icon-button is-size-m focus-ring-inset"
        appearance="plain"
        size="s"
        aria-label="Hide workbench"
        title="Hide workbench"
        @click=${callbacks.onCloseWorkbench}
      >
        ${waIcon('chevron-right')}
      </wa-button>
    </div>
  `;
}
