import 'dockview/dist/styles/dockview.css';
import './dockStyles.css';
import {
  createDockview,
  type DockviewApi,
  type DockviewGroupPanel,
  type AddPanelPositionOptions,
} from 'dockview';
import { html, nothing, render } from 'lit';

import { renderEmptyState } from '@ui/wa/emptyState';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';

import {
  closeWorkbenchTab,
  openWorkbenchTab,
  type DesktopShellState,
  type WorkbenchKind,
  type WorkbenchTab,
} from '../shared/desktopShellState';
import { DESKTOP_WORKSPACE_COMMANDS } from '../shared/desktopWorkspaceMessages';
import { dockGroupActions, dockTab } from './dockControls';
import type { createEditorPane } from './editorPane';
import type { createPdfPane } from './pdfPane';
import type { createTerminalPane } from './terminalPane';
import type { createReviewPane } from './reviewPane';

interface WorkbenchControllerDeps {
  session: string;
  isActive(): boolean;
  isBrowserCovered(): boolean;
  conversationView: HTMLElement;
  fileTree: ReturnType<typeof createEditorPane>;
  editorFor(id: string): ReturnType<typeof createEditorPane>;
  closeEditor(id: string): void;
  terminalPane: ReturnType<typeof createTerminalPane>;
  reviewPane: ReturnType<typeof createReviewPane>;
  pdfPane: ReturnType<typeof createPdfPane>;
  logsPane: HTMLElement;
  getState(): DesktopShellState;
  updateShell(next: DesktopShellState): void;
  postMessage(command: string, payload?: Record<string, unknown>): void;
}

/** A project owns one dock. Reparenting a panel never disposes its resources. */
export function createWorkbenchController(deps: WorkbenchControllerDeps) {
  const {
    getState,
    updateShell,
    postMessage,
    isActive,
    editorFor,
    terminalPane,
  } = deps;
  const element = document.createElement('div');
  element.className = 'shell-dock';
  element.dataset.session = deps.session;
  element.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.key !== 'F10' || !event.shiftKey)
      return;
    const tab = (event.target as HTMLElement)
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
  const loadedBrowserTabs = new Set<string>();
  const mounted = new Map<string, HTMLElement>();
  const subscriptions: { dispose(): void }[] = [];
  const tabFor = (id: string) =>
    getState().workbenchTabs.find((tab) => tab.id === id);

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
      postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE);
      return;
    }
    const rect = slot.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS, {
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
          tabElement.style.maxWidth = `${Math.min(260, Math.max(56, header.clientWidth - controlsWidth))}px`;
          const left = tabElement.offsetLeft;
          const right = left + tabElement.offsetWidth;
          if (right > strip.scrollLeft + strip.clientWidth)
            strip.scrollLeft = right - strip.clientWidth;
          else if (left < strip.scrollLeft) strip.scrollLeft = left;
        }
        const tab = tabFor(panel.id);
        if (tab?.kind === 'editor' && tab.target) editorFor(tab.id).layout();
        if (tab?.kind === 'terminal')
          terminalPane.activate(tab.id, { focus: false });
        if (
          tab?.kind === 'browser' &&
          tab.target &&
          !loadedBrowserTabs.has(tab.id)
        ) {
          loadedBrowserTabs.add(tab.id);
          postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_OPEN, {
            tabId: tab.id,
            url: tab.target,
          });
        }
        if (tab?.kind === 'logs') mounted.get(tab.id)?.append(deps.logsPane);
      }
      syncBrowserViewBounds();
    });
  }

  function mount(tab: WorkbenchTab): HTMLElement {
    const host = document.createElement('section');
    host.className = `shell-dock-surface shell-dock-${tab.kind}`;
    host.dataset.kind = tab.kind;
    host.dataset.panelId = tab.id;
    if (tab.kind === 'agent') {
      host.classList.add('shell-conversation');
      host.append(deps.conversationView);
    } else if (tab.kind === 'files') {
      host.classList.add('shell-files');
      host.append(deps.fileTree.treeElement);
      void deps.fileTree.refresh();
    } else if (tab.kind === 'editor' && tab.target) {
      const editor = editorFor(tab.id);
      host.append(editor.element);
      const footer = document.createElement('footer');
      footer.className = 'shell-editor-toolbar';
      render(
        html`<span class="shell-editor-path" title=${tab.target}
            >${tab.target}</span
          >
          ${renderLabeledActionButton({
            text: 'Save',
            icon: 'floppy-disk',
            kind: 'ghost',
            className: 'is-compact',
            onClick: () => void editor.save(),
          })}`,
        footer,
      );
      host.append(footer);
      void editor.open(tab.target);
    } else if (tab.kind === 'terminal')
      host.append(terminalPane.elementFor(tab.id));
    else if (tab.kind === 'review') host.append(deps.reviewPane.element);
    else if (tab.kind === 'pdf') host.append(deps.pdfPane.frameFor(tab));
    else if (tab.kind === 'browser') host.dataset.browserSlot = tab.id;
    else if (tab.kind === 'logs' && isActive()) host.append(deps.logsPane);
    mounted.set(tab.id, host);
    return host;
  }

  function release(tab: WorkbenchTab) {
    mounted.delete(tab.id);
    if (tab.kind === 'editor') deps.closeEditor(tab.id);
    if (tab.kind === 'terminal') {
      pendingTerminalCommands.delete(tab.id);
      terminalPane.dispose(tab.id);
    }
    if (tab.kind === 'pdf') deps.pdfPane.dispose(tab.id);
    if (tab.kind === 'browser') {
      loadedBrowserTabs.delete(tab.id);
      postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE, { tabId: tab.id });
    }
  }

  function disposeWorkbenchTab(id: string) {
    const tab = tabFor(id);
    if (
      !tab ||
      (tab.dirty && !window.confirm(`Discard unsaved changes to ${tab.title}?`))
    )
      return;
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
        ? { kind, target: 'https://texra.ai/', title: 'texra.ai' }
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
    if (!dock?.panels.length) return undefined;
    const sameKind = dock.panels.find(
      (panel) => tabFor(panel.id)?.kind === tab.kind,
    );
    if (sameKind) return { referencePanel: sameKind };
    const document = dock.panels.find((panel) =>
      ['editor', 'pdf', 'review', 'browser'].includes(
        tabFor(panel.id)?.kind ?? '',
      ),
    );
    if (tab.kind === 'terminal' || tab.kind === 'logs') {
      return {
        referencePanel: document ?? dock.activePanel ?? dock.panels[0]!,
        direction: 'below',
      };
    }
    if (tab.kind === 'agent') return { direction: 'left' };
    if (tab.kind === 'files' && document)
      return { referencePanel: document, direction: 'left' };
    const files = dock.getPanel('workbench:files');
    if (['editor', 'pdf', 'review', 'browser'].includes(tab.kind) && document)
      return { referencePanel: document };
    return {
      referencePanel: files ?? dock.activePanel ?? dock.panels[0]!,
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
      },
      disableFloatingGroups: true,
      defaultRenderer: 'always',
      dndStrategy: 'pointer',
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
        render(
          renderEmptyState({
            icon: 'table-columns',
            title: 'Arrange your workspace',
            body: 'Drag a tab here, or use the group menu to open a view.',
          }),
          watermark,
        );
        return { element: watermark, init() {} };
      },
    });
    reconciling = true;
    if (getState().dockLayout) {
      try {
        dock.fromJSON(getState().dockLayout!);
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
  }

  const actions = {
    api: () => dock!,
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
          if (tab.kind === 'files') panel.api.setSize({ width: 220 });
          if (tab.kind === 'agent') panel.api.setSize({ width: 380 });
          if (tab.kind === 'terminal' || tab.kind === 'logs')
            panel.api.setSize({ height: 220 });
          if (
            tab.kind === 'editor' &&
            !dock.panels.some(
              (other) =>
                other.id !== tab.id && tabFor(other.id)?.kind === 'editor',
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
