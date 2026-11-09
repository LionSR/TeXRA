import 'dockview/dist/styles/dockview.css';
import './dockStyles.css';
import {
  createDockview,
  type DockviewApi,
  type DockviewGroupPanel,
  type AddPanelPositionOptions,
} from 'dockview';
import { html, nothing, render } from 'lit';

import { TEXRA_SITE_URL } from '@ui/copy/guide';
import { renderEmptyState } from '@ui/wa/emptyState';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';

import {
  WORKBENCH_KIND_META,
  closeWorkbenchTab,
  openWorkbenchTab,
  type DesktopShellState,
  type WorkbenchKind,
  type WorkbenchTab,
} from '../shared/desktopShellState';
import {
  DESKTOP_WORKSPACE_COMMANDS,
  type DesktopWorkspaceRequest,
} from '../shared/desktopWorkspaceMessages';
import { dockGroupActions, dockTab } from './dockControls';
import type { createTerminalPane } from './terminalPane';

/**
 * What one kind of pane does in the dock. `zone` places a new tab when no tab
 * of its kind is open: `edge` at the dock's left edge, `navigator` left of the
 * documents, `document` with them, `bottom` below them.
 */
export interface PaneKind {
  readonly zone: 'edge' | 'navigator' | 'document' | 'bottom';
  /** The panel's size when its tab is first added. */
  readonly size?: { readonly width?: number; readonly height?: number };
  /** Fill the panel's element, once per tab. */
  mount(tab: WorkbenchTab, host: HTMLElement): void;
  /** Each layout while the panel is visible. */
  layout?(tab: WorkbenchTab, host: HTMLElement): void;
  /** When the panel becomes the dock's active one. */
  activate?(tab: WorkbenchTab): void;
  /** Each state update, for a tab whose record changed in place. */
  update?(tab: WorkbenchTab): void;
  /** The tab closed: release what `mount` acquired. */
  release?(tab: WorkbenchTab): void;
}

interface WorkbenchControllerDeps {
  session: string;
  isActive(): boolean;
  isBrowserCovered(): boolean;
  /** Asks before discarding a dirty tab; runs `discard` only on consent. */
  confirmDiscard(title: string, discard: () => void): void;
  panes: { readonly [K in WorkbenchKind]: PaneKind };
  terminalPane: ReturnType<typeof createTerminalPane>;
  getState(): DesktopShellState;
  updateShell(next: DesktopShellState): void;
  postMessage(message: DesktopWorkspaceRequest): void;
}

/** A project owns one dock. Reparenting a panel never disposes its resources. */
export function createWorkbenchController(deps: WorkbenchControllerDeps) {
  const { getState, updateShell, postMessage, isActive, panes, terminalPane } =
    deps;
  const element = document.createElement('div');
  element.className = 'shell-dock';
  element.dataset.session = deps.session;
  element.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.key !== 'F10' || !event.shiftKey)
      return;
    if (!(event.target instanceof Element)) return;
    const tab = event.target
      .closest('.dv-tab')
      ?.querySelector<HTMLElement>('.shell-dock-tab');
    if (!tab) return;
    event.preventDefault();
    const bounds = tab.getBoundingClientRect();
    tab.dispatchEvent(
      new MouseEvent('contextmenu', {
        clientX: bounds.left,
        clientY: bounds.bottom,
      }),
    );
  });
  let dock: DockviewApi | undefined;
  let reconciling = false;
  let disposed = false;
  let persistFrame: number | undefined;
  let layoutFrame: number | undefined;
  let openingGroup: DockviewGroupPanel | undefined;
  let lastRequestedTab: string | undefined;
  let dragging = false;
  const pendingTerminalCommands = new Map<string, string>();
  const mounted = new Map<string, HTMLElement>();
  const subscriptions: { dispose(): void }[] = [];
  const tabFor = (id: string) =>
    getState().workbenchTabs.find((tab) => tab.id === id);
  const zoneOf = (id: string) => {
    const tab = tabFor(id);
    return tab && panes[tab.kind].zone;
  };

  function persist() {
    if (reconciling || disposed || !dock || persistFrame !== undefined) return;
    persistFrame = requestAnimationFrame(() => {
      persistFrame = undefined;
      if (!dock || disposed) return;
      const activeTabId = dock.activePanel?.id;
      lastRequestedTab = activeTabId;
      updateShell({ ...getState(), activeTabId, dockLayout: dock.toJSON() });
    });
  }

  function syncBrowserViewBounds() {
    const tab = getState().workbenchTabs.find(
      (entry) => entry.kind === 'browser',
    );
    const slot = tab ? mounted.get(tab.id) : undefined;
    const visible = tab && dock?.getPanel(tab.id)?.api.isVisible;
    if (
      !isActive() ||
      !visible ||
      !slot ||
      deps.isBrowserCovered() ||
      dragging
    ) {
      postMessage({ command: DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE });
      return;
    }
    const rect = slot.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    postMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS,
      tabId: tab.id,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  }

  function layoutVisibleSurfaces() {
    if (disposed || !isActive() || layoutFrame !== undefined) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = undefined;
      if (!dock) syncState();
      if (!dock || disposed || !isActive()) return;
      if (
        dock.width !== element.clientWidth ||
        dock.height !== element.clientHeight
      )
        dock.layout(element.clientWidth, element.clientHeight);
      for (const panel of dock.panels) {
        if (!panel.api.isVisible) continue;
        // The library reveals tabs chosen from its overflow menu, but API
        // activations and asynchronous browser titles also need the complete
        // tab (including Close) inside the available strip.
        const tabElement = element
          .querySelector<HTMLElement>(
            `.dv-tabs-container .shell-dock-tab[data-tab-id="${CSS.escape(panel.id)}"]`,
          )
          ?.closest<HTMLElement>('.dv-tab');
        const strip = tabElement?.closest<HTMLElement>('.dv-tabs-container');
        const header = strip?.closest<HTMLElement>(
          '.dv-tabs-and-actions-container',
        );
        if (tabElement && strip && header && strip.clientWidth) {
          const controlsWidth = [
            ...header.querySelectorAll<HTMLElement>(
              ':scope > .dv-pre-actions-container, :scope > .dv-left-actions-container, :scope > .dv-right-actions-container',
            ),
          ].reduce((width, control) => width + control.offsetWidth, 0);
          // Measure the available header, not the current tab's shrink-wrapped
          // strip, or repeated layouts gradually truncate even short titles.
          tabElement.style.maxWidth = `${Math.max(56, Math.min(260, header.clientWidth - controlsWidth))}px`;
          const left = tabElement.offsetLeft;
          const right = left + tabElement.offsetWidth;
          if (right > strip.scrollLeft + strip.clientWidth)
            strip.scrollLeft = right - strip.clientWidth;
          else if (left < strip.scrollLeft) strip.scrollLeft = left;
        }
        const tab = tabFor(panel.id);
        const host = tab && mounted.get(tab.id);
        if (tab && host) panes[tab.kind].layout?.(tab, host);
      }
      syncBrowserViewBounds();
    });
  }

  function mount(tab: WorkbenchTab): HTMLElement {
    const host = document.createElement('section');
    host.className = `shell-dock-surface shell-dock-${tab.kind}`;
    host.dataset.kind = tab.kind;
    host.dataset.panelId = tab.id;
    panes[tab.kind].mount(tab, host);
    mounted.set(tab.id, host);
    return host;
  }

  function release(tab: WorkbenchTab) {
    mounted.delete(tab.id);
    pendingTerminalCommands.delete(tab.id);
    panes[tab.kind].release?.(tab);
  }

  function disposeWorkbenchTab(id: string) {
    const tab = tabFor(id);
    if (!tab) return;
    if (tab.dirty) deps.confirmDiscard(tab.title, () => removeTab(id));
    else removeTab(id);
  }

  function removeTab(id: string) {
    const tab = tabFor(id);
    if (!tab || disposed) return;
    reconciling = true;
    try {
      const panel = dock?.getPanel(id);
      if (panel) dock?.removePanel(panel);
      release(tab);
      const next = closeWorkbenchTab(getState(), id);
      lastRequestedTab = dock?.activePanel?.id;
      updateShell({
        ...next,
        activeTabId: lastRequestedTab,
        dockLayout: dock?.toJSON() ?? null,
      });
    } finally {
      reconciling = false;
    }
    layoutVisibleSurfaces();
  }

  function openKind(kind: WorkbenchKind, group?: DockviewGroupPanel) {
    openingGroup = group;
    const request =
      kind === 'browser'
        ? { kind, target: `${TEXRA_SITE_URL}/`, title: 'texra.ai' }
        : { kind };
    updateShell(openWorkbenchTab(getState(), request));
    syncState();
    if (group) {
      const panel = dock?.getPanel(getState().activeTabId ?? '');
      if (panel && panel.group !== group) panel.api.moveTo({ group });
    }
    openingGroup = undefined;
  }

  function positionFor(tab: WorkbenchTab): AddPanelPositionOptions | undefined {
    if (openingGroup) return { referenceGroup: openingGroup };
    const firstPanel = dock?.panels.at(0);
    if (!dock || !firstPanel) return undefined;
    const sameKind = dock.panels.find(
      (panel) => tabFor(panel.id)?.kind === tab.kind,
    );
    if (sameKind) return { referencePanel: sameKind };
    const document = dock.panels.find(
      (panel) => zoneOf(panel.id) === 'document',
    );
    const fallback = dock.activePanel ?? firstPanel;
    switch (panes[tab.kind].zone) {
      case 'edge':
        return { direction: 'left' };
      case 'bottom':
        return { referencePanel: document ?? fallback, direction: 'below' };
      case 'navigator':
        if (document) return { referencePanel: document, direction: 'left' };
        break;
      case 'document':
        if (document) return { referencePanel: document };
        break;
    }
    return {
      referencePanel: dock.getPanel('workbench:files') ?? fallback,
      direction: 'right',
    };
  }

  function ensureDock() {
    if (
      dock ||
      !element.isConnected ||
      !element.clientWidth ||
      !element.clientHeight
    )
      return;
    dock = createDockview(element, {
      theme: {
        name: 'texra',
        className: 'dockview-theme-texra',
        gap: 1,
        dndOverlayMounting: 'absolute',
        dndPanelOverlay: 'group',
      },
      disableFloatingGroups: true,
      defaultRenderer: 'always',
      dndStrategy: 'pointer',
      // Outer-edge drops make a column/row beside the entire workspace.
      // Give that target a usable hit area and preview its resulting size.
      dndEdges: {
        activationSize: { type: 'pixels', value: 24 },
        size: { type: 'percentage', value: 100 / 3 },
        smallWidthBoundary: 0,
        smallHeightBoundary: 0,
      },
      // Preview the resulting group, including its tab strip, even when the
      // destination is compact. Tab-strip drops keep the insertion marker.
      dropOverlayModel: ({ location }) =>
        location === 'content'
          ? { smallWidthBoundary: 0, smallHeightBoundary: 0 }
          : undefined,
      createComponent: ({ id }) => {
        const tab = tabFor(id);
        if (!tab) throw new Error(`Unknown saved workspace tab: ${id}`);
        return {
          element: mounted.get(id) ?? mount(tab),
          init() {},
          layout: layoutVisibleSurfaces,
          onShow: layoutVisibleSurfaces,
        };
      },
      createTabComponent: ({ id }) => dockTab(id, actions),
      defaultTabComponent: 'texra',
      createRightHeaderActionComponent: (group) =>
        dockGroupActions(group, actions),
      createWatermarkComponent: () => {
        const watermark = document.createElement('div');
        watermark.className = 'shell-dock-empty';
        return {
          element: watermark,
          init({ containerApi, group }) {
            const target = containerApi.groups.find(
              (candidate) => candidate.id === group?.id,
            );
            render(
              html`
                ${renderEmptyState({
                  icon: 'table-columns',
                  title: target ? 'Empty group' : 'Open a view',
                  body: 'Drag a tab here, or choose a view below.',
                })}
                <div class="shell-dock-empty-actions">
                  ${(['agent', 'files', 'terminal'] as const).map((kind) =>
                    renderLabeledActionButton({
                      text: WORKBENCH_KIND_META[kind].label,
                      icon: WORKBENCH_KIND_META[kind].icon,
                      kind: 'secondary',
                      onClick: () => openKind(kind, target),
                    }),
                  )}
                  ${
                    target
                      ? renderLabeledActionButton({
                          text: 'Close empty group',
                          icon: 'xmark',
                          kind: 'ghost',
                          onClick: () => {
                            if (target.panels.length === 0)
                              containerApi.removeGroup(target);
                          },
                        })
                      : nothing
                  }
                </div>
              `,
              watermark,
            );
          },
          dispose() {
            render(nothing, watermark);
          },
        };
      },
    });
    reconciling = true;
    const savedLayout = getState().dockLayout;
    if (savedLayout) {
      try {
        dock.fromJSON(savedLayout);
      } catch (error) {
        console.warn('[desktop] Rebuilding unreadable docking layout', error);
        dock.clear();
      }
    }
    reconciling = false;
    subscriptions.push(
      dock.onDidLayoutChange(() => {
        persist();
        layoutVisibleSurfaces();
      }),
    );
    subscriptions.push(
      dock.onDidActivePanelChange(() => {
        const tab = dock?.activePanel && tabFor(dock.activePanel.id);
        if (tab) panes[tab.kind].activate?.(tab);
        persist();
        layoutVisibleSurfaces();
      }),
    );
    subscriptions.push(
      dock.onWillDragPanel(() => {
        dragging = true;
        syncBrowserViewBounds();
      }),
    );
    subscriptions.push(
      dock.onWillDragGroup(() => {
        dragging = true;
        syncBrowserViewBounds();
      }),
    );
    subscriptions.push(
      dock.onWillDrop((event) => {
        if (event.kind !== 'edge' || event.position === 'center') return;
        const data = event.getData();
        const id =
          data?.panelId ??
          dock?.groups.find((group) => group.id === data?.groupId)?.activePanel
            ?.id;
        if (!id || !dock) return;
        const horizontal =
          event.position === 'left' || event.position === 'right';
        const size = horizontal
          ? { width: Math.round(dock.width / 3) }
          : { height: Math.round(dock.height / 3) };
        // Dockview completes the move synchronously. Resize the resulting
        // group before paint; its default equal redistribution would disagree
        // with the preview whenever the root already has several children.
        queueMicrotask(() => {
          if (!disposed) dock?.getPanel(id)?.group.api.setSize(size);
        });
      }),
    );
  }

  const actions = {
    api: () => {
      if (!dock) throw new Error('The workbench dock is not created yet.');
      return dock;
    },
    tab: tabFor,
    open: openKind,
    close: disposeWorkbenchTab,
  };
  function finishDrag() {
    dragging = false;
    layoutVisibleSurfaces();
  }
  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('dragend', finishDrag);

  function syncState() {
    if (disposed || reconciling) return;
    ensureDock();
    if (!dock) return;
    reconciling = true;
    let changed = false;
    try {
      for (const tab of getState().workbenchTabs) {
        let panel = dock.getPanel(tab.id);
        if (!panel) {
          changed = true;
          panel = dock.addPanel({
            id: tab.id,
            component: 'surface',
            title: tab.title,
            position: positionFor(tab),
            renderer: 'always',
            minimumWidth: 160,
            minimumHeight: 100,
          });
          const pane = panes[tab.kind];
          if (pane.size) panel.api.setSize(pane.size);
          // The first document narrows the agent and the file tree to give
          // it room.
          if (
            pane.zone === 'document' &&
            !dock.panels.some(
              (other) => other.id !== tab.id && zoneOf(other.id) === 'document',
            )
          ) {
            dock.getPanel('workbench:agent')?.api.setSize({
              width: Math.min(380, element.clientWidth * 0.35),
            });
            dock.getPanel('workbench:files')?.api.setSize({
              width: Math.min(220, element.clientWidth * 0.2),
            });
          }
        }
        if (panel.title !== tab.title) panel.api.setTitle(tab.title);
        if (panel.params?.dirty !== tab.dirty)
          panel.api.updateParameters({ dirty: tab.dirty });
        panes[tab.kind].update?.(tab);
      }
      const requested = getState().activeTabId;
      if (requested !== lastRequestedTab) {
        dock.getPanel(requested ?? '')?.api.setActive();
        changed = true;
      }
      lastRequestedTab = requested;
    } finally {
      reconciling = false;
    }
    layoutVisibleSurfaces();
    if (changed) persist();
  }

  return {
    element,
    syncState,
    openKind,
    showKind(kind: WorkbenchKind) {
      const existing = getState().workbenchTabs.findLast(
        (tab) => tab.kind === kind,
      );
      if (!existing) return openKind(kind);
      updateShell({ ...getState(), activeTabId: existing.id });
      syncState();
    },
    disposeWorkbenchTab,
    syncBrowserViewBounds,
    layoutVisibleSurfaces,
    activeTabId: () => dock?.activePanel?.id,
    isVisible: (kind: WorkbenchKind) =>
      dock?.panels.some(
        (panel) => panel.api.isVisible && tabFor(panel.id)?.kind === kind,
      ) ?? false,
    openTerminalCommand(initialCommand: string) {
      const next = openWorkbenchTab(getState(), { kind: 'terminal' });
      if (next.activeTabId)
        pendingTerminalCommands.set(next.activeTabId, initialCommand);
      updateShell(next);
      syncState();
      if (!isActive() && next.activeTabId)
        terminalPane.activate(next.activeTabId, {
          focus: false,
          background: true,
        });
    },
    takePendingTerminalCommand(id: string) {
      const command = pendingTerminalCommands.get(id);
      pendingTerminalCommands.delete(id);
      return command;
    },
    dispose() {
      disposed = true;
      if (persistFrame !== undefined) cancelAnimationFrame(persistFrame);
      if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
      document.removeEventListener('pointerup', finishDrag);
      document.removeEventListener('dragend', finishDrag);
      for (const subscription of subscriptions) subscription.dispose();
      dock?.dispose();
      for (const host of mounted.values()) render(nothing, host);
      mounted.clear();
    },
  };
}
