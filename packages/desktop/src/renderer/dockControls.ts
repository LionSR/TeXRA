import { html, nothing, render } from 'lit';

import { renderIconActionButton } from '@ui/wa/actionButtons';
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

interface DockActions {
  api(): DockviewApi;
  tab(id: string): WorkbenchTab | undefined;
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
  const draw = () =>
    render(
      html`
        <wa-dropdown
          placement="bottom-end"
          @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
            const value = event.detail.item.value;
            if (value === 'split-right') split('right');
            else if (value === 'split-below') split('below');
            else if (value === 'maximize') {
              if (group.api.isMaximized()) group.api.exitMaximized();
              else group.api.maximize();
            } else if (value === 'close-group') {
              for (const panel of [...group.panels]) actions.close(panel.id);
              if (
                actions.api().groups.includes(group) &&
                group.panels.length === 0
              )
                actions.api().removeGroup(group);
            } else if (value in WORKBENCH_KIND_META) {
              actions.open(value as WorkbenchKind, group);
            }
          }}
        >
          <wa-button
            slot="trigger"
            appearance="plain"
            size="s"
            class="icon-button btn-ghost is-compact"
            aria-label="Group actions"
          >
            ${waIcon('plus')}
          </wa-button>
          ${(['agent', 'files', 'terminal', 'browser', 'logs'] as const).map(
            (kind) => html`
              <wa-dropdown-item value=${kind}>
                ${waIcon(WORKBENCH_KIND_META[kind].icon, { slot: 'icon' })}
                ${WORKBENCH_KIND_META[kind].label}
              </wa-dropdown-item>
            `,
          )}
          <wa-divider></wa-divider>
          <wa-dropdown-item value="split-right"
            >Split group right</wa-dropdown-item
          >
          <wa-dropdown-item value="split-below"
            >Split group below</wa-dropdown-item
          >
          <wa-dropdown-item value="maximize">
            ${group.api.isMaximized() ? 'Restore group' : 'Maximize group'}
          </wa-dropdown-item>
          <wa-divider></wa-divider>
          <wa-dropdown-item value="close-group">Close group</wa-dropdown-item>
        </wa-dropdown>
      `,
      element,
    );
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
  let panel: IDockviewPanel | undefined;
  let titleSubscription: { dispose(): void } | undefined;
  function draw() {
    panel = actions.api().getPanel(id);
    const tab = actions.tab(id);
    if (!tab) return;
    element.dataset.kind = tab.kind;
    const groups = actions
      .api()
      .groups.filter((group) => group !== panel?.group);
    render(
      html`
        ${waIcon(WORKBENCH_KIND_META[tab.kind].icon)}
        <span class="shell-dock-tab-label" title=${tab.target ?? tab.title}
          >${tab.title}</span
        >
        ${tab.dirty ? html`<span class="shell-dock-dirty" aria-label="Unsaved changes">•</span>` : nothing}
        <span
          class="shell-dock-tab-close"
          @pointerdown=${(event: Event) => event.stopPropagation()}
          @click=${(event: Event) => event.stopPropagation()}
        >
          ${renderIconActionButton({
            icon: 'xmark',
            label: `Close ${tab.title}`,
            className: 'icon-button btn-ghost is-compact',
            size: 's',
            onClick: () => actions.close(id),
          })}
        </span>
        <wa-dropdown
          class="shell-dock-tab-menu"
          placement="bottom-start"
          @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
            const value = event.detail.item.value;
            if (value === 'close') actions.close(id);
            else if (value.startsWith('move:')) {
              const group = actions
                .api()
                .groups.find((entry) => entry.id === value.slice(5));
              if (group) panel?.api.moveTo({ group });
            } else {
              const position = value as 'left' | 'right' | 'top' | 'bottom';
              if (panel) panel.api.moveTo({ group: panel.group, position });
            }
          }}
        >
          <span slot="trigger" class="shell-dock-menu-anchor"></span>
          <wa-dropdown-item
            value="right"
            ?disabled=${panel?.group.panels.length === 1}
            >Move tab to new group right</wa-dropdown-item
          >
          <wa-dropdown-item
            value="bottom"
            ?disabled=${panel?.group.panels.length === 1}
            >Move tab to new group below</wa-dropdown-item
          >
          <wa-dropdown-item
            value="left"
            ?disabled=${panel?.group.panels.length === 1}
            >Move tab to new group left</wa-dropdown-item
          >
          <wa-dropdown-item
            value="top"
            ?disabled=${panel?.group.panels.length === 1}
            >Move tab to new group above</wa-dropdown-item
          >
          ${groups.length ? html`<wa-divider></wa-divider>` : nothing}
          ${groups.map(
            (group, index) =>
              html` <wa-dropdown-item value=${`move:${group.id}`}>
                Move to
                ${group.activePanel?.title ?? `empty group ${index + 1}`}
              </wa-dropdown-item>`,
          )}
          <wa-divider></wa-divider>
          <wa-dropdown-item value="close">Close tab</wa-dropdown-item>
        </wa-dropdown>
      `,
      element,
    );
  }
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    draw();
    const menu = element.querySelector<HTMLElement & { open: boolean }>(
      'wa-dropdown',
    );
    const anchor = element.querySelector<HTMLElement>(
      '.shell-dock-menu-anchor',
    );
    if (menu && anchor) {
      anchor.style.left = `${event.clientX}px`;
      anchor.style.top = `${event.clientY}px`;
      menu.open = true;
    }
  });
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'F10' || !event.shiftKey) return;
    event.preventDefault();
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        clientX: bounds.left,
        clientY: bounds.bottom,
      }),
    );
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
    },
  };
}
