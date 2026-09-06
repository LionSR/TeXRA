import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import { renderEmptyState } from '@shared/wa/emptyState';

import {
  workbenchPanelDomId,
  workbenchTabDomId,
  workbenchTabsTemplate,
} from './taskShell';
import {
  activeWorkbenchTab,
  closeWorkbench,
  closeWorkbenchTab,
  focusWorkbenchTab,
  moveWorkbenchTab,
  openWorkbenchTab,
  toggleWorkbench,
  WORKBENCH_PLACEMENTS,
  workbenchTabsForPlacement,
  type DesktopTaskShellState,
  type WorkbenchKind,
  type WorkbenchPlacement,
  type WorkbenchTab,
} from '../shared/desktopTaskShell';
import { DESKTOP_WORKSPACE_COMMANDS } from '../shared/desktopWorkspaceMessages';
import type { createEditorPane } from './editorPane';
import type { createPdfPane } from './pdfPane';
import type { createTerminalPane } from './terminalPane';
import type { createReviewPane } from './reviewPane';

interface WorkbenchControllerDeps {
  session: string;
  isActive(): boolean;
  editorPane: ReturnType<typeof createEditorPane>;
  terminalPane: ReturnType<typeof createTerminalPane>;
  reviewPane: ReturnType<typeof createReviewPane>;
  pdfPane: ReturnType<typeof createPdfPane>;
  /** The Subagents tab's content, read from the active paper's view. */
  subagentsTemplate(): TemplateResult | typeof nothing;
  settingsView: HTMLElement;
  logsPane: HTMLElement;
  getState(): DesktopTaskShellState;
  /** Root of the paper this window shows; new terminals start there. */
  getWorkspacePath(): string | undefined;
  updateShell(next: DesktopTaskShellState): void;
  postMessage(command: string, payload?: Record<string, unknown>): void;
}

interface WorkbenchController {
  openKind(kind: WorkbenchKind): void;
  openTerminalCommand(initialCommand: string): void;
  disposeWorkbenchTab(tabId: string): void;
  togglePlacementVisibility(
    placement: WorkbenchPlacement,
    emptyKind: WorkbenchKind,
  ): void;
  layoutVisibleSurfaces(options?: { focus?: boolean }): void;
  syncBrowserViewBounds(): void;
  template(placement: WorkbenchPlacement): TemplateResult;
  takePendingTerminalCommand(sessionId: string): string | undefined;
}

export function createWorkbenchController({
  session,
  isActive,
  editorPane,
  terminalPane,
  reviewPane,
  pdfPane,
  subagentsTemplate,
  settingsView,
  logsPane,
  getState,
  getWorkspacePath,
  updateShell,
  postMessage,
}: WorkbenchControllerDeps): WorkbenchController {
  const pendingTerminalCommands = new Map<string, string>();

  /**
   * Reports the browser slot's geometry to the main process, which positions the
   * WebContentsView over it. A WebContentsView is not part of renderer layout, so
   * this runs on every render, resize, and layout change — otherwise the view
   * would float where the slot used to be.
   *
   * Only one browser view can be shown at a time: each is a separate
   * WebContentsView layered over the window, and two would need two rectangles the
   * main process tracks independently. The active browser workbench tab wins; the
   * rest render their placeholder.
   */
  function syncBrowserViewBounds(): void {
    const tab = WORKBENCH_PLACEMENTS.map((placement) =>
      activeWorkbenchTab(getState(), placement),
    ).find((candidate) => candidate?.kind === 'browser');
    if (tab?.kind !== 'browser') {
      postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE);
      return;
    }
    const tabId = tab.id;
    // Measure after layout settles; a workbench that just appeared has no box
    // until the browser has flushed the style change.
    requestAnimationFrame(() => {
      if (!isActive()) return;
      const slot = document.querySelector(
        `[data-workbench-session="${CSS.escape(session)}"] [data-browser-slot="${CSS.escape(tabId)}"]`,
      );
      if (!slot) return;
      const rect = slot.getBoundingClientRect();
      postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS, {
        tabId,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    });
  }

  /**
   * Re-measures the active workbench surface. Monaco and xterm both render at
   * zero size if they measured while hidden. `focus` marks explicit user
   * activation (a tab was switched or opened) versus a layout pass that should
   * only re-fit surfaces.
   */
  function layoutVisibleSurfaces({
    focus = false,
  }: { focus?: boolean } = {}): void {
    for (const placement of WORKBENCH_PLACEMENTS) {
      const tab = activeWorkbenchTab(getState(), placement);
      if (!tab) continue;
      if (tab.kind === 'editor') {
        editorPane.layout();
        if (tab.target) void editorPane.open(tab.target);
      }
      // activate() creates the terminal on first use and re-fits an existing one.
      if (tab.kind === 'terminal') terminalPane.activate(tab.id, { focus });
      // The main process owns the WebContentsView, so hand it the URL once.
      if (
        tab.kind === 'browser' &&
        tab.target &&
        !loadedBrowserTabs.has(tab.id)
      ) {
        loadedBrowserTabs.add(tab.id);
        postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_OPEN, {
          tabId: tab.id,
          url: tab.target,
        });
      }
    }
  }

  /**
   * Browser tabs whose URL has already been handed to the main process. Without
   * this the page would reload on every re-render.
   */
  const loadedBrowserTabs = new Set<string>();

  /** Opens a surface in its default pane with a sensible default target. */
  function openKind(kind: WorkbenchKind): void {
    if (kind === 'terminal') {
      updateShell(
        openWorkbenchTab(getState(), {
          kind,
          target: getWorkspacePath() ?? '',
        }),
      );
      return;
    }
    if (kind === 'browser') {
      updateShell(
        openWorkbenchTab(getState(), {
          kind,
          target: 'https://texra.ai/',
          title: 'texra.ai',
        }),
      );
      return;
    }
    if (kind === 'editor') {
      updateShell(openWorkbenchTab(getState(), { kind }));
      void editorPane.refresh();
      return;
    }
    updateShell(openWorkbenchTab(getState(), { kind }));
  }

  /** Opens a visible bottom terminal and executes a settings-provided command. */
  function openTerminalCommand(initialCommand: string): void {
    const next = openWorkbenchTab(getState(), {
      kind: 'terminal',
      placement: 'bottom',
      target: getWorkspacePath() ?? '',
    });
    const terminal = activeWorkbenchTab(next, 'bottom');
    if (terminal?.kind !== 'terminal') return;
    pendingTerminalCommands.set(terminal.id, initialCommand);
    updateShell(next);
    // An explicit command belongs to its paper even when another paper is shown.
    if (!isActive()) terminalPane.activate(terminal.id, { focus: false });
  }

  /** Toggles a workbench pane, opening `emptyKind` when it holds no tabs yet. */
  function togglePlacementVisibility(
    placement: WorkbenchPlacement,
    emptyKind: WorkbenchKind,
  ): void {
    if (
      !activeWorkbenchTab(getState(), placement) &&
      workbenchTabsForPlacement(getState(), placement).length === 0
    ) {
      openKind(emptyKind);
      return;
    }
    updateShell(toggleWorkbench(getState(), placement));
  }

  // =============================================================================
  // Pane content
  // =============================================================================

  /**
   * Content for one tab. Every surface stays mounted once opened and is hidden when
   * its tab is inactive, so Monaco models, terminal scrollback, and in-flight
   * settings edits survive both tab switches and layout changes.
   *
   * The editor, terminal, settings, and logs surfaces are single shared instances,
   * so they render in whichever pane currently holds their tab — Lit moves the DOM
   * node rather than duplicating it.
   */
  function workbenchPlaceholderTemplate(): TemplateResult {
    return renderEmptyState({
      icon: 'file-code',
      title: 'Choose a file',
      body: 'Open a file from the project list to inspect or edit it beside this task.',
      headingTag: 'h2',
      className: 'task-workbench-placeholder',
      iconSurfaceSize: 'l',
    });
  }

  function workbenchSurfaceTemplate(content: unknown): TemplateResult {
    return html`<div class="task-workbench-surface">${content}</div>`;
  }

  function workbenchContentTemplate(
    tab: WorkbenchTab,
  ): TemplateResult | typeof nothing {
    switch (tab.kind) {
      case 'editor':
        return tab.target
          ? workbenchSurfaceTemplate(editorPane.element)
          : workbenchPlaceholderTemplate();
      case 'terminal':
        return workbenchSurfaceTemplate(terminalPane.element);
      case 'browser':
        return html`<div
          class="task-workbench-surface"
          data-browser-slot=${tab.id}
        ></div>`;
      case 'review':
        return workbenchSurfaceTemplate(reviewPane.element);
      case 'settings':
        return isActive() ? workbenchSurfaceTemplate(settingsView) : nothing;
      case 'logs':
        return isActive() ? workbenchSurfaceTemplate(logsPane) : nothing;
      case 'pdf':
        return workbenchSurfaceTemplate(pdfPane.frameFor(tab));
      case 'subagents':
        return workbenchSurfaceTemplate(subagentsTemplate());
    }
  }

  function disposeWorkbenchTab(tabId: string): void {
    const tab = getState().workbenchTabs.find((entry) => entry.id === tabId);
    if (tab?.kind === 'editor' && tab.target) {
      if (
        tab.dirty &&
        !window.confirm(`Discard unsaved changes to ${tab.title}?`)
      )
        return;
      editorPane.close(tab.target);
    }
    if (tab?.kind === 'browser') {
      loadedBrowserTabs.delete(tabId);
      postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE, { tabId });
    }
    if (tab?.kind === 'terminal') {
      pendingTerminalCommands.delete(tabId);
      terminalPane.dispose(tabId);
    }
    if (tab?.kind === 'pdf') pdfPane.dispose(tabId);
    updateShell(closeWorkbenchTab(getState(), tabId));
  }

  function moveTabToPlacement(
    tabId: string,
    placement: WorkbenchPlacement,
  ): void {
    updateShell(moveWorkbenchTab(getState(), tabId, placement));
  }

  function workbenchTemplate(placement: WorkbenchPlacement): TemplateResult {
    const state = getState();
    const tab = activeWorkbenchTab(state, placement);
    const tabs = workbenchTabsForPlacement(state, placement);
    // Each shared pane has one mount in the placement that currently owns it.
    // PDFs have one mount per tab; keeping these nodes connected preserves the viewer.
    const surfaces = tabs.filter((candidate) => {
      if (candidate.kind === 'pdf') return true;
      const owner =
        WORKBENCH_PLACEMENTS.map((side) =>
          activeWorkbenchTab(state, side),
        ).find((active) => active?.kind === candidate.kind) ??
        state.workbenchTabs.findLast((entry) => entry.kind === candidate.kind);
      return candidate.id === owner?.id;
    });
    const placementLabel = placement === 'right' ? 'Right' : 'Bottom';
    return html`
      <aside
        class="task-workbench"
        data-placement=${placement}
        aria-label=${`${placementLabel} workbench`}
      >
        ${workbenchTabsTemplate(
          workbenchTabsForPlacement(getState(), placement),
          getState().activeWorkbenchTabIds[placement],
          placement,
          {
            onActivate: (tabId) =>
              updateShell(focusWorkbenchTab(getState(), tabId)),
            onClose: disposeWorkbenchTab,
            onHide: () => updateShell(closeWorkbench(getState(), placement)),
            onMove: moveTabToPlacement,
          },
          session,
        )}
        <div class="task-workbench-body">
          <section
            class="task-workbench-pane"
            role="tabpanel"
            id=${workbenchPanelDomId(placement, session)}
            aria-labelledby=${tab ? workbenchTabDomId(tab.id, session) : nothing}
          >
            ${repeat(
              surfaces,
              (entry) => (entry.kind === 'pdf' ? entry.id : entry.kind),
              (entry) =>
                html`<div
                  class="task-workbench-retained-surface"
                  ?hidden=${entry.id !== tab?.id}
                >
                  ${workbenchContentTemplate(entry)}
                </div>`,
            )}
          </section>
        </div>
      </aside>
    `;
  }

  function takePendingTerminalCommand(sessionId: string): string | undefined {
    const initialCommand = pendingTerminalCommands.get(sessionId);
    pendingTerminalCommands.delete(sessionId);
    return initialCommand;
  }

  return {
    openKind,
    openTerminalCommand,
    disposeWorkbenchTab,
    togglePlacementVisibility,
    layoutVisibleSurfaces,
    syncBrowserViewBounds,
    template: workbenchTemplate,
    takePendingTerminalCommand,
  };
}
