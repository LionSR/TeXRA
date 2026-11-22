import { html, nothing, render } from 'lit';

import { renderIconActionButton } from '@ui/wa/actionButtons';
import { actionMenu } from '@ui/wa/actionMenu';
import { waIcon } from '@ui/wa/webAwesomeIcons';

import {
  WORKBENCH_KIND_META,
  type WorkbenchKind,
  type WorkbenchTab,
} from '../shared/desktopShellState';
import type {
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
  ITabRenderer,
} from 'dockview';

/** The kinds a group's menu opens beside its tabs. */
const GROUP_OPEN_KINDS = [
  'agent',
  'files',
  'terminal',
  'browser',
  'logs',
] as const satisfies readonly WorkbenchKind[];

/** Where a tab's menu moves it into a new group. */
const TAB_MOVE_POSITIONS = ['left', 'right', 'top', 'bottom'] as const;

interface DockActions {
  api(): DockviewApi;
  tab(id: string): WorkbenchTab | undefined;
  isDirty(id: string): boolean;
  open(kind: WorkbenchKind, group?: DockviewGroupPanel): void;
  close(id: string): void;
}

/** Group operations use the same menu and control skin as the rest of the app. */
export function dockGroupActions(
  group: DockviewGroupPanel,
  actions: DockActions,
) {
  const element = document.createElement('div');
  element.className = 'shell-dock-actions';
  function split(direction: 'right' | 'below') {
    const active = group.activePanel;
    if (active && group.panels.length > 1) {
      active.api.moveTo({
        group,
        position: direction === 'below' ? 'bottom' : 'right',
      });
    } else {
      actions.api().addGroup({ referenceGroup: group, direction });
    }
  }
  function closeGroup() {
    for (const panel of [...group.panels]) actions.close(panel.id);
    if (actions.api().groups.includes(group) && group.panels.length === 0)
      actions.api().removeGroup(group);
  }
  const draw = () => {
    const menu = actionMenu([
      ...GROUP_OPEN_KINDS.map((kind) => ({
        icon: WORKBENCH_KIND_META[kind].icon,
        label: WORKBENCH_KIND_META[kind].label,
        activate: () => actions.open(kind, group),
      })),
      {
        label: 'Split group right',
        dividerBefore: true,
        activate: () => split('right'),
      },
      { label: 'Split group below', activate: () => split('below') },
      {
        label: group.api.isMaximized() ? 'Restore group' : 'Maximize group',
        activate: () => {
          if (group.api.isMaximized()) group.api.exitMaximized();
          else group.api.maximize();
        },
      },
      { label: 'Close group', dividerBefore: true, activate: closeGroup },
    ]);
    render(
      html`
        <wa-dropdown placement="bottom-end" @wa-select=${menu.onSelect}>
          ${renderIconActionButton({
            icon: 'plus',
            label: 'Group actions',
            slot: 'trigger',
            size: 'm',
          })}
          ${menu.items}
        </wa-dropdown>
      `,
      element,
    );
  };
  return {
    element,
    init() {
      draw();
      element.addEventListener('wa-show', draw);
    },
    dispose() {
      element.removeEventListener('wa-show', draw);
      render(nothing, element);
    },
  };
}

/** The tab keeps title and close control in separate, non-overlapping columns. */
export function dockTab(id: string, actions: DockActions): ITabRenderer {
  const element = document.createElement('div');
  element.className = 'shell-dock-tab';
  element.dataset.tabId = id;
  // Dockview positions groups with transforms, which turn a fixed descendant
  // into group-relative coordinates. The pointer anchor must live at the root.
  const menuRoot = document.createElement('div');
  menuRoot.className = 'shell-dock-context-root';
  let panel: IDockviewPanel | undefined;
  let titleSubscription: { dispose(): void } | undefined;
  function draw() {
    panel = actions.api().getPanel(id);
    const tab = actions.tab(id);
    if (!tab) return;
    element.dataset.kind = tab.kind;
    render(
      html`
        ${waIcon(WORKBENCH_KIND_META[tab.kind].icon)}
        <span class="shell-dock-tab-label" title=${tab.target ?? tab.title}
          >${tab.title}</span
        >
        ${actions.isDirty(id) ? html`<span class="status-dot shell-dock-dirty" role="img" aria-label="Unsaved changes"></span>` : nothing}
        <span
          class="shell-dock-tab-close"
          @pointerdown=${(event: Event) => event.stopPropagation()}
          @click=${(event: Event) => event.stopPropagation()}
        >
          ${renderIconActionButton({
            icon: 'xmark',
            label: `Close ${tab.title}`,
            kind: 'ghost',
            className: 'is-compact',
            size: 's',
            onClick: () => actions.close(id),
          })}
        </span>
      `,
      element,
    );
  }
  function drawMenu() {
    panel = actions.api().getPanel(id);
    const groups = actions
      .api()
      .groups.filter((group) => group !== panel?.group);
    const alone = panel?.group.panels.length === 1;
    const moveToNewGroup = (
      position: (typeof TAB_MOVE_POSITIONS)[number],
      label: string,
    ) => ({
      label,
      disabled: alone,
      activate: () => {
        if (panel) panel.api.moveTo({ group: panel.group, position });
      },
    });
    const menu = actionMenu([
      moveToNewGroup('right', 'Move tab to new group right'),
      moveToNewGroup('bottom', 'Move tab to new group below'),
      moveToNewGroup('left', 'Move tab to new group left'),
      moveToNewGroup('top', 'Move tab to new group above'),
      ...groups.map((group, index) => ({
        label: `Move to ${group.activePanel?.title ?? `empty group ${index + 1}`}`,
        dividerBefore: index === 0,
        activate: () => panel?.api.moveTo({ group }),
      })),
      {
        label: 'Close tab',
        dividerBefore: true,
        activate: () => actions.close(id),
      },
    ]);
    render(
      html`
        <wa-dropdown
          class="shell-dock-tab-menu"
          placement="bottom-start"
          distance="0"
          @wa-select=${menu.onSelect}
        >
          <span slot="trigger" class="shell-dock-menu-anchor"></span>
          ${menu.items}
        </wa-dropdown>
      `,
      menuRoot,
    );
  }
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    for (const other of document.querySelectorAll<
      HTMLElement & { open: boolean }
    >('.shell-dock-tab-menu[open]')) {
      other.open = false;
    }
    drawMenu();
    if (!menuRoot.isConnected) document.body.append(menuRoot);
    const menu = menuRoot.querySelector<HTMLElement & { open: boolean }>(
      'wa-dropdown',
    );
    const anchor = menuRoot.querySelector<HTMLElement>(
      '.shell-dock-menu-anchor',
    );
    if (menu && anchor) {
      anchor.style.left = `${event.clientX}px`;
      anchor.style.top = `${event.clientY}px`;
      menu.open = true;
    }
  });
  element.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    actions.close(id);
  });
  return {
    element,
    init(params) {
      panel = params.containerApi.getPanel(id);
      titleSubscription = params.api.onDidTitleChange(draw);
      draw();
    },
    update: draw,
    dispose() {
      titleSubscription?.dispose();
      render(nothing, element);
      render(nothing, menuRoot);
      menuRoot.remove();
    },
  };
}
