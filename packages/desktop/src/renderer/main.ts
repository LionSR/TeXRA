// Bundled product typeface. Imported before the token sheets so the faces are
// registered by the time --wa-font-family-body resolves. Geist carries the UI,
// JetBrains Mono the code/terminal/path surfaces; both are self-hosted rather
// than fetched, since the app must render identically offline.
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';

import './styles.css';
import './themeTokens.css';

import '@shared/wa';
// Side-effect import, placed after the shared icon contract so the desktop's
// Lucide resolver owns both Web Awesome library names. Registration runs at
// module scope inside that file because ES imports hoist above statements.
import './desktopIconLibrary';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/popover/popover.js';
import '@awesome.me/webawesome/dist/components/split-panel/split-panel.js';
import { html, nothing, render, type TemplateResult } from 'lit';
import '@progressView/frontend';
import './TexraDiffView';
import type { StreamTabs } from '@progressView/frontend/components/StreamTabs';
import {
  handleFileAction,
  handleFollowUpChange,
  handleFollowUpFocusComplete,
  handleFollowUpPolish,
  handleFollowUpSend,
  handleGettingStartedAction,
  handlePermissionAction,
  handleStreamDelete,
  handleStreamSwitch,
  handleToolbarCommand,
  runCompileFixer,
  requestStreamDeselection,
  requestStreamSwitch,
} from '@progressView/frontend/eventHandlers';
import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
import {
  activeStreamId$,
  appState,
  childStreamsByParent$,
  displayedActiveStreamId$,
  hasAnyStreams$,
  pendingApprovalIds$,
  streamStates$,
  streams$,
  topLevelStreams$,
} from '@progressView/frontend/progressState';
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import '@settingsView/frontend';
import '@webview/frontend';
import { hostBridge, postMessage } from '@shared/hostBridge';
import {
  SETTINGS_TAB,
  type StreamTabId,
  type DesktopThemeKind,
} from '@shared/schemas';

import { Signal } from '@shared/signals';
import { resolvePostMessageTargetOrigin } from '@shared/postMessageOrigin';

import { formatDesktopAccelerator } from '@shared/commands/accelerators';

import { applyHostBodyTheme } from '@shared/wa/hostTheme';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@shared/wa/actionButtons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { type DesktopLayoutPanel } from '../shared/desktopShellMessages';
import {
  buildDesktopMainViewResetMessage,
  buildDesktopSettingsTabMessage,
  DESKTOP_LOCAL_COMMANDS,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandId,
} from '../shared/desktopCommandSurface';
import { DESKTOP_ONBOARDING_COMMANDS } from '../shared/desktopOnboardingMessages';
import {
  createDesktopCommandPalette,
  type CommandPaletteController,
} from './desktopCommandPalette';
import {
  createDesktopShortcutRegistry,
  desktopCommandPaletteShortcut,
  DESKTOP_COMMAND_PALETTE_ID,
} from './desktopShortcutRegistry';
import { createStartupTeamPanel } from './desktopOnboarding';
import { createEditorPane } from './editorPane';
import { createTerminalPane } from './terminalPane';
import './taskShell.css';
import {
  taskSidebarTemplate,
  workbenchPanelDomId,
  workbenchTabDomId,
  workbenchTabsTemplate,
} from './taskShell';
import {
  activeWorkbenchTab,
  closeWorkbench,
  closeWorkbenchTab,
  focusWorkbenchTab,
  initialDesktopTaskShellState,
  moveWorkbenchTab,
  openWorkbenchTab,
  renameWorkbenchTab,
  setBottomPanelHeight,
  setProjectSectionPosition,
  setSidebarWidth,
  setWorkbenchTabDirty,
  setWorkbenchWidth,
  toggleFiles,
  toggleSidebar,
  toggleSummaryBar,
  toggleWorkbench,
  WORKBENCH_PLACEMENTS,
  workbenchTabsForPlacement,
  workspaceInitials,
  workspaceName,
  type DesktopTaskShellState,
  type WorkbenchKind,
  type WorkbenchPlacement,
  type WorkbenchTab,
} from '../shared/desktopTaskShell';
import {
  DESKTOP_WORKSPACE_COMMANDS,
  type DesktopEnvironmentSummary,
} from '../shared/desktopWorkspaceMessages';
import { getRendererPlatform } from './rendererPlatform';
import { createPdfOverlay } from './pdfOverlay';
import { createReviewPane } from './reviewPane';
import { createDesktopPromptOverlay } from './promptOverlay';
import { createLogsPane } from './logsPane';
import {
  requestFileRead,
  requestFileWrite,
  requestFiles,
} from './fileRequests';
import { createMessageRoutes } from './messageRoutes';

const appRoot = document.querySelector<HTMLElement>('#app')!;

if (appRoot == null) {
  throw new Error('TeXRA desktop renderer root was not found.');
}
const startupTeamPanel = createStartupTeamPanel({
  dismiss: () => postMessage(DESKTOP_ONBOARDING_COMMANDS.DISMISS),
  onVisibilityChanged: rerenderShell,
  showLauncher: returnToLauncher,
  openMultiAgent: () => openSettingsTab(SETTINGS_TAB.MULTI_AGENT),
});

// =============================================================================
// Task shell
// =============================================================================
//
// The conversation is the permanent task canvas. Project navigation stays in
// the left sidebar, while files and tools share one optional right workbench.

const hasWorkspace = window.texraDesktop?.hasWorkspace ?? true;
const rendererPlatform = getRendererPlatform(document.defaultView);
document.body.dataset.desktopPlatform = rendererPlatform;
const desktopMenuEntries = getDesktopCommandMenuEntries(rendererPlatform);
const shortcutAcceleratorsById = new Map<string, string | undefined>(
  desktopMenuEntries.map((entry) => [entry.id, entry.accelerator]),
);
// One name per action: chrome labels and tooltips quote the command catalog
// verbatim (the same source the palette and the Settings shortcut list read)
// instead of paraphrasing it in sentence case.
const commandLabelsById = new Map<string, string>(
  desktopMenuEntries.map((entry) => [entry.id, entry.label]),
);
const commandPaletteShortcut = desktopCommandPaletteShortcut(rendererPlatform);
shortcutAcceleratorsById.set(
  commandPaletteShortcut.id,
  commandPaletteShortcut.accelerator,
);
commandLabelsById.set(commandPaletteShortcut.id, commandPaletteShortcut.label);

function commandLabel(
  commandId: DesktopCommandId | typeof DESKTOP_COMMAND_PALETTE_ID,
): string {
  return commandLabelsById.get(commandId) ?? commandId;
}

function commandTitle(
  commandId: DesktopCommandId | typeof DESKTOP_COMMAND_PALETTE_ID,
): string {
  const shortcut = formatDesktopAccelerator(
    shortcutAcceleratorsById.get(commandId),
    rendererPlatform,
  );
  const label = commandLabel(commandId);
  return shortcut ? `${label} - ${shortcut}` : label;
}

// =============================================================================
// Conversation-first shell state
// =============================================================================
//
// The task canvas is permanent. Workbench tabs can live in independently
// resizable Right and Bottom panes without replacing the conversation.

let shellState: DesktopTaskShellState = initialDesktopTaskShellState();
let environmentSummary: DesktopEnvironmentSummary | undefined;
let environmentLoading = false;
let environmentPopoverOpen = false;

function updateShell(next: DesktopTaskShellState): void {
  if (next === shellState) return;
  const previousActiveTabIds = shellState.activeWorkbenchTabIds;
  const previousBottomPanelHeight = shellState.bottomPanelHeight;
  const previousSidebarWidth = shellState.sidebarWidth;
  const previousWorkbenchWidth = shellState.workbenchWidth;
  shellState = next;
  rerenderShell();
  syncBrowserViewBounds();
  const activeTabChanged =
    previousActiveTabIds.right !== next.activeWorkbenchTabIds.right ||
    previousActiveTabIds.bottom !== next.activeWorkbenchTabIds.bottom;
  if (
    activeTabChanged ||
    previousBottomPanelHeight !== next.bottomPanelHeight ||
    previousSidebarWidth !== next.sidebarWidth ||
    previousWorkbenchWidth !== next.workbenchWidth
  ) {
    // A new active tab is explicit user activation, so its surface may take
    // focus; a size-only change is a layout pass and must not move focus.
    layoutVisibleSurfaces({ focus: activeTabChanged });
  }
}

/** Toggles a workbench pane, opening `emptyKind` when it holds no tabs yet. */
function togglePlacementVisibility(
  placement: WorkbenchPlacement,
  emptyKind: WorkbenchKind,
): void {
  if (
    !activeWorkbenchTab(shellState, placement) &&
    workbenchTabsForPlacement(shellState, placement).length === 0
  ) {
    openKind(emptyKind);
    return;
  }
  updateShell(toggleWorkbench(shellState, placement));
}

function toggleBottomBarVisibility(): void {
  togglePlacementVisibility('bottom', 'terminal');
}

function toggleSidePanelVisibility(): void {
  togglePlacementVisibility('right', 'settings');
}

function toggleSummaryBarVisibility(): void {
  environmentPopoverOpen = false;
  updateShell(toggleSummaryBar(shellState));
}

// `<settings-app>`, `<main-app>`, and `<stream-conversation>` are instantiated
// once and slotted into the shell template via Lit's DOM-node interpolation, so
// Lit preserves their internal state across re-renders and tab switches.
const mainView: HTMLElement = document.createElement('main-app');
mainView.setAttribute('data-desktop-view', 'main');
const noWorkspacePlaceholder: HTMLElement = document.createElement('section');
if (!hasWorkspace) {
  // Empty-state placeholder when no workspace is open. The launcher cannot
  // run anything without a workspace; show a minimal prompt instead.
  noWorkspacePlaceholder.className = 'desktop-empty-workspace';
  render(
    html`
      <section class="desktop-empty-workspace-panel">
        <div class="shell-empty-icon icon-surface is-size-l">
          ${waIcon('folder-open')}
        </div>
        <h1>Open a folder to start</h1>
        <p>
          TeXRA needs a workspace before it can find your files, run agents, and
          place their output.
        </p>
        <ul class="desktop-empty-workspace-capabilities">
          <li>Pick the TeX, Markdown, or source files an agent should read.</li>
          <li>Run a team of agents with the model you choose.</li>
          <li>Follow progress, edit files, and review output in one window.</li>
        </ul>
        <div class="desktop-empty-workspace-actions">
          ${renderLabeledActionButton({
            icon: 'folder-open',
            text: 'Open Folder',
            appearance: 'filled',
            variant: 'brand',
            className: 'btn-primary',
            onClick: () =>
              postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
          })}
        </div>
      </section>
    `,
    noWorkspacePlaceholder,
  );
}

const conversationView: HTMLElement = document.createElement(
  'stream-conversation',
);
conversationView.setAttribute('data-desktop-view', 'progress');

// Left rail: a <stream-tabs> mount wired directly to module-level
// progressState rather than nested inside <progress-app>.
const railTabs = document.createElement('stream-tabs') as StreamTabs;

const settingsView: HTMLElement = document.createElement('settings-app');
settingsView.setAttribute('data-desktop-view', 'settings');

// The logs viewer is hosted directly in its workbench tab body.
const logsController = createLogsPane();
const logsPane = logsController.element;

// Editor + terminal panes. Both are created eagerly but load their heavy
// dependencies (Monaco, xterm) lazily on first activation, so an app that never
// opens either pays nothing.
const editorPane = createEditorPane({
  listFiles: (directory) => requestFiles(directory),
  readFile: (path) => requestFileRead(path),
  writeFile: (path, contents) => requestFileWrite(path, contents),
  onRequestOpen: (path) => {
    updateShell(openWorkbenchTab(shellState, { kind: 'editor', target: path }));
  },
  onDirtyChange: (path, dirty) => {
    updateShell(
      setWorkbenchTabDirty(shellState, `workbench:editor:${path}`, dirty),
    );
  },
  onError: (error) => console.error('TeXRA editor pane', error),
});

const pendingTerminalCommands = new Map<string, string>();
const terminalPane = createTerminalPane({
  start: (sessionId, cols, rows) => {
    const initialCommand = pendingTerminalCommands.get(sessionId);
    pendingTerminalCommands.delete(sessionId);
    postMessage(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START, {
      sessionId,
      cols,
      rows,
      ...(initialCommand ? { initialCommand } : {}),
    });
  },
  sendInput: (sessionId, data) =>
    postMessage(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_INPUT, { sessionId, data }),
  resize: (sessionId, cols, rows) =>
    postMessage(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_RESIZE, {
      sessionId,
      cols,
      rows,
    }),
  close: (sessionId) =>
    postMessage(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_CLOSE, { sessionId }),
});

const reviewPane = createReviewPane();
const pdfOverlay = createPdfOverlay(appRoot);
const promptOverlay = createDesktopPromptOverlay(appRoot, (message) =>
  hostBridge.postMessage(message),
);

// =============================================================================
// Editor / terminal / browser request plumbing
// The renderer is sandboxed, so file I/O runs in the main process. The
// promise-correlated request bridge for editor reads/writes/lists lives in
// ./fileRequests.ts.

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
    activeWorkbenchTab(shellState, placement),
  ).find((candidate) => candidate?.kind === 'browser');
  if (tab?.kind !== 'browser') {
    postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE);
    return;
  }
  const tabId = tab.id;
  // Measure after layout settles; a workbench that just appeared has no box
  // until the browser has flushed the style change.
  requestAnimationFrame(() => {
    const slot = document.querySelector(`[data-browser-slot="${tabId}"]`);
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
    const tab = activeWorkbenchTab(shellState, placement);
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
      openWorkbenchTab(shellState, {
        kind,
        target: window.texraDesktop?.workspacePath ?? '',
      }),
    );
    return;
  }
  if (kind === 'browser') {
    updateShell(
      openWorkbenchTab(shellState, {
        kind,
        target: 'https://texra.ai/',
        title: 'texra.ai',
      }),
    );
    return;
  }
  if (kind === 'editor') {
    updateShell(openWorkbenchTab(shellState, { kind }));
    void editorPane.refresh();
    return;
  }
  updateShell(openWorkbenchTab(shellState, { kind }));
}

/** Opens a visible bottom terminal and executes a settings-provided command. */
function openTerminalCommand(initialCommand: string): void {
  const next = openWorkbenchTab(shellState, {
    kind: 'terminal',
    placement: 'bottom',
    target: window.texraDesktop?.workspacePath ?? '',
  });
  const terminal = activeWorkbenchTab(next, 'bottom');
  if (terminal?.kind !== 'terminal') return;
  pendingTerminalCommands.set(terminal.id, initialCommand);
  updateShell(next);
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

function workbenchContentTemplate(tab: WorkbenchTab): TemplateResult {
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
      return workbenchSurfaceTemplate(settingsView);
    case 'logs':
      return workbenchSurfaceTemplate(logsPane);
  }
}

function disposeWorkbenchTab(tabId: string): void {
  const tab = shellState.workbenchTabs.find((entry) => entry.id === tabId);
  if (tab?.kind === 'browser') {
    loadedBrowserTabs.delete(tabId);
    postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE, { tabId });
  }
  if (tab?.kind === 'terminal') {
    pendingTerminalCommands.delete(tabId);
    terminalPane.dispose(tabId);
  }
  updateShell(closeWorkbenchTab(shellState, tabId));
}

function moveTabToPlacement(
  tabId: string,
  placement: WorkbenchPlacement,
): void {
  updateShell(moveWorkbenchTab(shellState, tabId, placement));
}

function workbenchTemplate(
  tab: WorkbenchTab,
  placement: WorkbenchPlacement,
): TemplateResult {
  const placementLabel = placement === 'right' ? 'Right' : 'Bottom';
  return html`
    <aside
      class="task-workbench"
      data-placement=${placement}
      aria-label=${`${placementLabel} workbench`}
    >
      ${workbenchTabsTemplate(
        workbenchTabsForPlacement(shellState, placement),
        shellState.activeWorkbenchTabIds[placement],
        placement,
        {
          onActivate: (tabId) =>
            updateShell(focusWorkbenchTab(shellState, tabId)),
          onClose: disposeWorkbenchTab,
          onHide: () => updateShell(closeWorkbench(shellState, placement)),
          onMove: moveTabToPlacement,
        },
      )}
      <div class="task-workbench-body">
        <section
          class="task-workbench-pane"
          role="tabpanel"
          id=${workbenchPanelDomId(placement)}
          aria-labelledby=${workbenchTabDomId(tab.id)}
        >
          ${workbenchContentTemplate(tab)}
        </section>
      </div>
    </aside>
  `;
}

function currentTaskTitle(): string {
  const activeId = activeStreamId$.get();
  const stream = streams$.get().find((entry) => entry.name === activeId);
  return stream?.label || stream?.name || 'New task';
}

function environmentPopoverTemplate(
  workspacePath: string | undefined,
): TemplateResult {
  const childCount = [...childStreamsByParent$.get().values()].reduce(
    (total, children) => total + children.length,
    0,
  );
  const terminalCount = shellState.workbenchTabs.filter(
    (tab) => tab.kind === 'terminal',
  ).length;
  const sources = shellState.workbenchTabs.filter(
    (tab) => tab.kind === 'editor' && tab.target,
  );
  const branchLabel =
    environmentSummary?.branch ?? (environmentLoading ? 'Loading…' : 'Local');
  const changedFiles = environmentSummary?.changedFiles ?? 0;

  return html`
    <wa-popover
      class="task-environment-popover"
      for="taskEnvironmentButton"
      placement="bottom-end"
      distance="6"
      without-arrow
      .open=${environmentPopoverOpen}
      @wa-show=${handleEnvironmentPopoverShow}
      @wa-hide=${handleEnvironmentPopoverHide}
    >
      <div class="task-environment-heading">
        <span>Environment</span>
        <wa-button
          type="button"
          class="task-environment-refresh icon-button is-size-m"
          appearance="plain"
          size="s"
          aria-label="Refresh environment"
          title="Refresh environment"
          ?disabled=${environmentLoading}
          @click=${requestEnvironmentSummary}
        >
          ${waIcon(environmentLoading ? 'spinner' : 'rotate-right')}
        </wa-button>
      </div>
      <div class="task-environment-section">
        <div class="task-environment-row">
          <span class="task-environment-row-icon">${waIcon('plus-minus')}</span>
          <span>Changes</span>
          <span class="task-environment-trailing task-environment-diff">
            <span class="is-added">+${environmentSummary?.additions ?? 0}</span>
            <span class="is-deleted"
              >-${environmentSummary?.deletions ?? 0}</span
            >
          </span>
        </div>
        <div class="task-environment-row">
          <span class="task-environment-row-icon"
            >${waIcon('folder-open')}</span
          >
          <span title=${workspacePath ?? ''}
            >${workspaceName(workspacePath)}</span
          >
          <span class="task-environment-trailing">
            ${changedFiles} changed
          </span>
        </div>
        <div class="task-environment-row">
          <span class="task-environment-row-icon"
            >${waIcon('code-branch')}</span
          >
          <span title=${branchLabel}>${branchLabel}</span>
          ${environmentSyncTemplate(environmentSummary)}
        </div>
        <div class="task-environment-row">
          <span class="task-environment-row-icon">${waIcon('circle-dot')}</span>
          <span>Commit or push</span>
          <span class="task-environment-trailing">
            ${changedFiles === 0 ? 'Clean' : `${changedFiles} pending`}
          </span>
        </div>
      </div>

      <div class="task-environment-section">
        <div class="task-environment-section-title">Agents</div>
        <div class="task-environment-row">
          <span class="task-environment-row-icon">${waIcon('users')}</span>
          <span>Subagents</span>
          <span class="task-environment-trailing">
            ${childCount === 0 ? 'None' : `${childCount} active or completed`}
          </span>
        </div>
      </div>

      <div class="task-environment-section">
        <div class="task-environment-section-title">Background processes</div>
        <div class="task-environment-row">
          <span class="task-environment-row-icon">${waIcon('terminal')}</span>
          <span>Background terminal</span>
          <span class="task-environment-trailing">
            ${terminalCount === 0 ? 'None' : terminalCount}
          </span>
        </div>
      </div>

      <div class="task-environment-section">
        <div class="task-environment-section-title">Sources</div>
        ${
          sources.length === 0
            ? html`
                <div class="task-environment-row is-muted">
                  <span class="task-environment-row-icon">
                    ${waIcon('link')}
                  </span>
                  <span>No open sources</span>
                </div>
              `
            : sources.slice(0, 3).map(
                (source) => html`
                  <div class="task-environment-row">
                    <span class="task-environment-row-icon">
                      ${waIcon('file-code')}
                    </span>
                    <span title=${source.target ?? ''}>${source.title}</span>
                  </div>
                `,
              )
        }
        ${
          sources.length > 3
            ? html`
                <div class="task-environment-more">
                  +${sources.length - 3} more
                </div>
              `
            : nothing
        }
      </div>
    </wa-popover>
  `;
}

function environmentSyncTemplate(
  summary: DesktopEnvironmentSummary | undefined,
): TemplateResult {
  if (!summary?.upstream) {
    return html`
      <span class="task-environment-trailing is-muted">No upstream</span>
    `;
  }
  if (summary.ahead === 0 && summary.behind === 0) {
    return html`
      <span class="task-environment-trailing is-success">
        ${waIcon('circle-check')} Synced
      </span>
    `;
  }
  // role="img" gives the aria-label a host so screen readers announce words
  // ("3 ahead, 2 behind") instead of the raw ↑/↓ glyphs.
  const syncLabel = [
    summary.ahead > 0 ? `${summary.ahead} ahead` : '',
    summary.behind > 0 ? `${summary.behind} behind` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return html`
    <span class="task-environment-trailing" role="img" aria-label=${syncLabel}>
      ${summary.ahead > 0 ? `↑${summary.ahead}` : nothing}
      ${summary.behind > 0 ? `↓${summary.behind}` : nothing}
    </span>
  `;
}

function handleEnvironmentPopoverShow(): void {
  environmentPopoverOpen = true;
  requestEnvironmentSummary();
}

function handleEnvironmentPopoverHide(): void {
  environmentPopoverOpen = false;
}

function requestEnvironmentSummary(): void {
  if (environmentLoading) return;
  environmentLoading = true;
  postMessage(DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_REQUEST);
}

function taskConversationTemplate(): TemplateResult {
  const activeId = activeStreamId$.get();
  const showConversation = activeId != null && hasAnyStreams$.get();
  const startupPanelVisible = startupTeamPanel.isVisible();
  const sidebarToggleLabel = shellState.sidebarCollapsed
    ? 'Show sidebar'
    : 'Hide sidebar';
  // Names the button even when the ≤560px container query collapses it to the
  // icon: the shadow button then has no visible text, so only `title` reaches
  // its accessible name.
  const environmentButtonLabel = `${workspaceName(window.texraDesktop?.workspacePath)} environment`;
  return html`
    <main class="task-conversation" aria-label="Task conversation">
      <header class="task-header">
        <wa-button
          type="button"
          class="task-header-button icon-button is-size-l"
          appearance="plain"
          size="s"
          aria-label=${sidebarToggleLabel}
          title=${sidebarToggleLabel}
          @click=${() => updateShell(toggleSidebar(shellState))}
        >
          ${waIcon(
            shellState.sidebarCollapsed ? 'chevron-right' : 'chevron-left',
          )}
        </wa-button>
        <span class="task-header-title">${currentTaskTitle()}</span>
        <span class="task-header-spacer"></span>
        ${
          shellState.summaryBarVisible
            ? html`
                <wa-button
                  id="taskEnvironmentButton"
                  type="button"
                  class="task-environment-button btn-secondary"
                  appearance="outlined"
                  size="s"
                  aria-label=${environmentButtonLabel}
                  title=${environmentButtonLabel}
                  with-caret
                >
                  ${waIcon('folder-open', { slot: 'start' })}
                  <span
                    >${workspaceName(window.texraDesktop?.workspacePath)}</span
                  >
                </wa-button>
              `
            : nothing
        }
        <wa-button
          type="button"
          class="task-header-button icon-button is-size-l"
          appearance="plain"
          size="s"
          aria-label=${commandLabel(DESKTOP_COMMAND_PALETTE_ID)}
          title=${commandTitle(DESKTOP_COMMAND_PALETTE_ID)}
          @click=${openCommandPalette}
        >
          ${waIcon('ellipsis')}
        </wa-button>
        <div
          class="task-layout-controls"
          role="group"
          aria-label="Layout controls"
        >
          ${renderIconActionButton({
            id: 'taskToggleSummaryBar',
            icon: 'list-ul',
            label: commandLabel(DESKTOP_LOCAL_COMMANDS.TOGGLE_SUMMARY_BAR),
            tooltip: commandTitle(DESKTOP_LOCAL_COMMANDS.TOGGLE_SUMMARY_BAR),
            className: 'task-layout-toggle',
            size: 'l',
            pressed: shellState.summaryBarVisible,
            onClick: toggleSummaryBarVisibility,
          })}
          ${renderIconActionButton({
            id: 'taskToggleBottomBar',
            icon: 'window-maximize',
            label: commandLabel(DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR),
            tooltip: commandTitle(DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR),
            className: 'task-layout-toggle',
            size: 'l',
            pressed: activeWorkbenchTab(shellState, 'bottom') != null,
            onClick: toggleBottomBarVisibility,
          })}
          ${renderIconActionButton({
            id: 'taskToggleSidePanel',
            icon: 'picture-in-picture',
            label: commandLabel(DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL),
            tooltip: commandTitle(DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL),
            className: 'task-layout-toggle',
            size: 'l',
            pressed: activeWorkbenchTab(shellState, 'right') != null,
            onClick: toggleSidePanelVisibility,
          })}
        </div>
        ${
          shellState.summaryBarVisible
            ? environmentPopoverTemplate(window.texraDesktop?.workspacePath)
            : nothing
        }
      </header>
      <div class="task-conversation-body" id="desktop-center">
        <section
          class="task-conversation-pane"
          data-pane="launcher"
          ?hidden=${showConversation}
        >
          ${
            hasWorkspace
              ? html`
                  <section
                    class="task-launcher-surface"
                    ?hidden=${startupPanelVisible}
                  >
                    ${mainView}
                  </section>
                `
              : noWorkspacePlaceholder
          }
          ${startupTeamPanel.template()}
        </section>
        <section
          class="task-conversation-pane"
          data-pane="conversation"
          ?hidden=${!showConversation}
        >
          ${conversationView}
        </section>
      </div>
    </main>
  `;
}

interface SplitPanelElement extends HTMLElement {
  readonly position: number;
  readonly positionInPixels: number;
}

/**
 * Record a size the user just dragged a split handle to. Deliberately not
 * `updateShell`: the panel has already moved itself and the surface
 * ResizeObserver relays the new bounds, so re-rendering here would only fight
 * the drag. The value is kept so the next render starts from it.
 */
function recordLayoutMeasurement(next: DesktopTaskShellState): void {
  shellState = next;
}

function rememberSidebarWidth(event: Event): void {
  const width = (event.currentTarget as SplitPanelElement).positionInPixels;
  recordLayoutMeasurement(setSidebarWidth(shellState, width));
}

function rememberProjectSectionPosition(event: Event): void {
  const position = (event.currentTarget as SplitPanelElement).position;
  recordLayoutMeasurement(setProjectSectionPosition(shellState, position));
}

function rememberBottomPanelHeight(event: Event): void {
  const height = (event.currentTarget as SplitPanelElement).positionInPixels;
  recordLayoutMeasurement(setBottomPanelHeight(shellState, height));
}

function rememberWorkbenchWidth(event: Event): void {
  const width = (event.currentTarget as SplitPanelElement).positionInPixels;
  recordLayoutMeasurement(setWorkbenchWidth(shellState, width));
}

function taskRightLayoutTemplate(
  rightTab: WorkbenchTab | undefined,
): TemplateResult {
  if (!rightTab) return taskConversationTemplate();
  return html`
    <wa-split-panel
      class="task-main-split"
      orientation="horizontal"
      primary="end"
      position-in-pixels=${shellState.workbenchWidth}
      @wa-reposition=${rememberWorkbenchWidth}
    >
      <span slot="divider" class="task-split-handle">
        ${waIcon('ellipsis')}
      </span>
      <div slot="start" class="task-main-panel">
        ${taskConversationTemplate()}
      </div>
      <div slot="end" class="task-workbench-panel">
        ${workbenchTemplate(rightTab, 'right')}
      </div>
    </wa-split-panel>
  `;
}

function taskMainTemplate(
  rightTab: WorkbenchTab | undefined,
  bottomTab: WorkbenchTab | undefined,
): TemplateResult {
  const rightLayout = taskRightLayoutTemplate(rightTab);
  if (!bottomTab) return rightLayout;
  return html`
    <wa-split-panel
      class="task-bottom-split"
      orientation="vertical"
      primary="end"
      position-in-pixels=${shellState.bottomPanelHeight}
      @wa-reposition=${rememberBottomPanelHeight}
    >
      <span slot="divider" class="task-bottom-split-handle">
        ${waIcon('ellipsis')}
      </span>
      <div slot="start" class="task-main-panel">${rightLayout}</div>
      <div slot="end" class="task-bottom-workbench-panel">
        ${workbenchTemplate(bottomTab, 'bottom')}
      </div>
    </wa-split-panel>
  `;
}

function shellTemplate(): TemplateResult {
  const workspacePath = window.texraDesktop?.workspacePath;
  const rightTab = activeWorkbenchTab(shellState, 'right');
  const bottomTab = activeWorkbenchTab(shellState, 'bottom');
  const main = taskMainTemplate(rightTab, bottomTab);
  const workbenchOpen = rightTab != null || bottomTab != null;

  if (shellState.sidebarCollapsed) {
    return html`
      <div
        class="task-shell task-shell-collapsed"
        data-workbench-open=${String(workbenchOpen)}
        data-right-panel-open=${String(rightTab != null)}
        data-bottom-panel-open=${String(bottomTab != null)}
      >
        ${main}
      </div>
    `;
  }

  return html`
    <wa-split-panel
      class="task-shell"
      orientation="horizontal"
      primary="start"
      .positionInPixels=${shellState.sidebarWidth}
      data-workbench-open=${String(workbenchOpen)}
      data-right-panel-open=${String(rightTab != null)}
      data-bottom-panel-open=${String(bottomTab != null)}
      @wa-reposition=${rememberSidebarWidth}
    >
      <span slot="divider" class="task-split-handle">
        ${waIcon('ellipsis')}
      </span>
      <div slot="start" class="task-sidebar-slot">
        ${taskSidebarTemplate(
          {
            files: editorPane.treeElement,
            filesExpanded: shellState.filesExpanded,
            hasWorkspace,
            initials: workspaceInitials(workspacePath),
            projectSectionPosition: shellState.projectSectionPosition,
            sessions: railTabs,
            streamCount: streams$.get().length,
            workspaceName: workspaceName(workspacePath),
            commandsLabel: commandLabel(DESKTOP_COMMAND_PALETTE_ID),
            ...(workspacePath ? { workspacePath } : {}),
          },
          {
            onNewTask: returnToLauncher,
            onSearch: openCommandPalette,
            onToggleFiles: () => {
              const next = toggleFiles(shellState);
              updateShell(next);
              if (next.filesExpanded) void editorPane.refresh();
            },
            onOpenFolder: () =>
              postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
            onOpenTerminal: () => openKind('terminal'),
            onOpenBrowser: () => openKind('browser'),
            onOpenSettings: () => openKind('settings'),
            onOpenLogs: () => openKind('logs'),
            onResizeProjectSection: rememberProjectSectionPosition,
          },
        )}
      </div>
      <div slot="end" class="task-shell-main-panel">${main}</div>
    </wa-split-panel>
  `;
}

let surfaceResizeObserver: ResizeObserver | undefined;

function observeSurfaceResizes(): void {
  surfaceResizeObserver ??= new ResizeObserver(() => {
    editorPane.layout();
    terminalPane.layout();
    syncBrowserViewBounds();
  });
  surfaceResizeObserver.disconnect();
  for (const element of document.querySelectorAll(
    '.task-conversation, .task-workbench',
  )) {
    surfaceResizeObserver.observe(element);
  }
}

function rerenderShell(): void {
  render(shellTemplate(), appRoot);
  logsController.setActive(
    activeWorkbenchTab(shellState, 'right')?.kind === 'logs' ||
      activeWorkbenchTab(shellState, 'bottom')?.kind === 'logs',
  );
  railTabs.streams = topLevelStreams$.get();
  railTabs.activeStreamId = displayedActiveStreamId$.get();
  railTabs.streamStates = streamStates$.get();
  railTabs.pendingApprovalStreamIds = pendingApprovalIds$.get();
  railTabs.childStreamsByParent = childStreamsByParent$.get();
  observeSurfaceResizes();
}

function toBootstrapErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'TeXRA could not finish starting up.';
}

function renderBootstrapFallback(error: unknown): void {
  const message = toBootstrapErrorMessage(error);
  const reload = () => window.location.reload();
  render(
    html`
      <section class="desktop-bootstrap-fallback" role="alert">
        <div class="desktop-bootstrap-fallback-panel">
          <h1>TeXRA could not start</h1>
          <p>${message}</p>
          <p>
            If you just denied a keychain prompt, your saved API keys and
            sign-in session are unavailable. You can continue without them, or
            reload after granting access.
          </p>
          <div class="desktop-bootstrap-fallback-actions">
            <wa-button appearance="filled" variant="brand" @click=${reload}>
              Reload
            </wa-button>
            <wa-button
              appearance="outlined"
              @click=${recoverFromBootstrapFallback}
            >
              Continue without saved secrets
            </wa-button>
          </div>
        </div>
      </section>
    `,
    appRoot,
  );
}

function recoverFromBootstrapFallback(): void {
  try {
    logsController.rerenderViewer();
    rerenderShell();
    // Recovery must wire rail tabs / conversation events and install the
    // signal watcher. Without these the recovered shell renders but stays
    // inert (rail clicks ignored, signal changes don't trigger rerenders).
    wireRailTabs();
    wireConversation();
    installShellSignalWatcher();
    bootstrapFailed = false;
    postMessage(DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE);
    postWebviewReady();
    document.body.dataset.desktopReady = 'true';
  } catch (recoveryError) {
    console.error('TeXRA desktop renderer recovery failed', recoveryError);
    bootstrapFailed = true;
    renderBootstrapFallback(recoveryError);
  }
}

// =============================================================================
// Signal watcher + bootstrap
// =============================================================================

let shellWatcherInstalled = false;

function installShellSignalWatcher(): void {
  if (shellWatcherInstalled) return;
  shellWatcherInstalled = true;
  // Subscribe to module-level progress signals so the center-pane swap
  // (launcher ↔ conversation) and the rail tab properties stay live. Use
  // `Signal.subtle.Watcher` from @lit-labs/signals (TC39 polyfill) — this
  // is what `SignalWatcher(LitElement)` wraps internally. We schedule the
  // re-render on a microtask so multiple synchronous signal writes batch.
  const shellDeps = new Signal.Computed(() => {
    activeStreamId$.get();
    displayedActiveStreamId$.get();
    hasAnyStreams$.get();
    topLevelStreams$.get();
    streamStates$.get();
    pendingApprovalIds$.get();
    childStreamsByParent$.get();
    return Date.now();
  });
  let shellRerenderQueued = false;
  const shellWatcher = new Signal.subtle.Watcher(() => {
    if (shellRerenderQueued) return;
    shellRerenderQueued = true;
    queueMicrotask(() => {
      shellRerenderQueued = false;
      // Read the pending computed so the watcher re-tracks its dependencies.
      for (const pending of shellWatcher.getPending()) pending.get();
      // Re-arm in `finally`: a Watcher fires once and stays dormant until
      // `watch()` runs again, so letting a throw from `rerenderShell()` skip
      // it would freeze the whole shell on stale data with no error and no
      // recovery (same defect fixed in the CLI's `subscribeToSignalChanges`).
      try {
        rerenderShell();
      } finally {
        shellWatcher.watch();
      }
    });
  });
  shellWatcher.watch(shellDeps);
  // Prime the dependency graph so the watcher knows what to listen for.
  shellDeps.get();
}

let bootstrapFailed = false;
try {
  logsController.rerenderViewer();
  rerenderShell();
  installShellSignalWatcher();
} catch (error) {
  bootstrapFailed = true;
  console.error('TeXRA desktop renderer bootstrap failed', error);
  renderBootstrapFallback(error);
}

if (bootstrapFailed) {
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled rejection after bootstrap failure', event.reason);
  });
}

// =============================================================================
// Settings
// =============================================================================
//
// Settings is a tab, not a modal dialog: configuring a run while watching it is
// the common case, which an overlay would make mutually exclusive.

type ShowSettingsArgs = Parameters<DesktopCommandActions['showSettings']>;

function openSettingsTab(
  tabIndex?: ShowSettingsArgs[0],
  agentSubTab?: ShowSettingsArgs[1],
): void {
  openKind('settings');
  if (tabIndex == null) return;
  window.postMessage(
    buildDesktopSettingsTabMessage(tabIndex, agentSubTab),
    resolvePostMessageTargetOrigin(window.location.origin),
  );
}

// =============================================================================
// Onboarding + command palette
// =============================================================================

const desktopRendererCommandActions: DesktopCommandActions = {
  showLauncher: returnToLauncher,
  openWorkbench: openKind,
  showSettings: openSettingsTab,
  showStream: switchToStream,
  openDesktopDocs: () => {
    postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS);
  },
  openLogFolder: () => {
    postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER);
  },
  openWorkspaceFolder: () => {
    postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER);
  },
  saveFile: () => {
    void editorPane.save();
  },
  showFirstRunWalkthrough: () => {
    startupTeamPanel.show();
  },
  toggleBottomBar: toggleBottomBarVisibility,
  toggleSidePanel: toggleSidePanelVisibility,
  toggleSummaryBar: toggleSummaryBarVisibility,
  resetMainView: () => {
    returnToLauncher();
    window.postMessage(
      buildDesktopMainViewResetMessage(),
      resolvePostMessageTargetOrigin(window.location.origin),
    );
  },
};
let commandPalette: CommandPaletteController | undefined;
const shortcutRegistry = bootstrapFailed
  ? undefined
  : createDesktopShortcutRegistry({
      document,
      actions: desktopRendererCommandActions,
      openCommands: () => commandPalette?.open(),
    });
if (!bootstrapFailed) {
  commandPalette = createDesktopCommandPalette({
    document,
    canOpen: () => true,
    actions: desktopRendererCommandActions,
    getStreams: () => streams$.get(),
    getShortcuts: () => shortcutRegistry?.entries() ?? [],
  });
  document.body.append(commandPalette.element);
}
const disposeShortcutHints = shortcutRegistry?.subscribe((entries) => {
  shortcutAcceleratorsById.clear();
  for (const entry of entries) {
    shortcutAcceleratorsById.set(entry.id, entry.accelerator);
  }
  rerenderShell();
});

function openCommandPalette(): void {
  commandPalette?.open();
}

function switchToStream(streamId: StreamTabId): void {
  if (!appState.get().streamById.has(streamId)) return;
  requestStreamSwitch(streamId);
}

// Clear the active stream so the center pane swaps back to <main-app>.
function returnToLauncher(): void {
  requestStreamDeselection();
}

const LAYOUT_PANEL_TOGGLES: Record<DesktopLayoutPanel, () => void> = {
  bottomBar: toggleBottomBarVisibility,
  sidePanel: toggleSidePanelVisibility,
  summaryBar: toggleSummaryBarVisibility,
};

/**
 * Every inbound window message the shell claims, in match order: the first
 * route whose schema parses handles it. Shell routes come first, then the
 * main-process replies for the editor, terminal, and browser panes.
 */
const MESSAGE_ROUTES = createMessageRoutes({
  saveAllFiles: () => {
    void editorPane.save();
  },
  isBootstrapFailed: () => bootstrapFailed,
  returnToLauncher,
  openKind,
  toggleLayoutPanel: (panel) => LAYOUT_PANEL_TOGGLES[panel](),
  onboarding: {
    show: () => startupTeamPanel.show(),
    hide: () => startupTeamPanel.hide(),
  },
  applyTheme: applyDesktopTheme,
  logs: { applySnapshot: (message) => logsController.applySnapshot(message) },
  review: {
    open: (message) => reviewPane.open(message),
    clear: () => reviewPane.clear(),
  },
  disposeReviewTab: () => disposeWorkbenchTab('workbench:review'),
  pdf: {
    open: (message) => pdfOverlay.open(message),
    close: () => pdfOverlay.close(),
  },
  prompt: { open: (message) => promptOverlay.open(message) },
  terminal: {
    write: (sessionId, data) => terminalPane.write(sessionId, data),
    reportExit: (sessionId, exitCode) =>
      terminalPane.reportExit(sessionId, exitCode),
    reportError: (sessionId, message) =>
      terminalPane.reportError(sessionId, message),
  },
  openTerminalCommand,
  renameBrowserTab: (tabId, title) =>
    updateShell(renameWorkbenchTab(shellState, tabId, title)),
  environment: {
    set: (summary, loading) => {
      environmentSummary = summary;
      environmentLoading = loading;
    },
    rerender: rerenderShell,
  },
});

window.addEventListener('message', (event) => {
  for (const route of MESSAGE_ROUTES) {
    if (route(event.data)) return;
  }
  // Progress view messages dispatch directly into the shared
  // messageDispatcher, with no <progress-app> mounted for plumbing.
  // dispatchMessage validates internally and no-ops on a parse failure.
  dispatchMessage(event.data);
});

// Keep the embedded browser aligned when the window resizes: its view is
// positioned in absolute window coordinates, not renderer layout.
window.addEventListener('resize', () => {
  syncBrowserViewBounds();
  editorPane.layout();
  terminalPane.layout();
});

// =============================================================================
// Wire <stream-tabs> + <stream-conversation> events to shared handlers
// =============================================================================

// Each guard below protects its wiring function against double-registration:
// a bootstrap recovery attempt that itself fails re-renders the same
// fallback UI, whose button re-invokes recoverFromBootstrapFallback()
// against these same module-level railTabs/conversationView elements, which
// never get recreated or torn down for the life of the renderer.
let railTabsWired = false;

function wireRailTabs(): void {
  if (railTabsWired) return;
  railTabsWired = true;
  railTabs.addEventListener(
    'stream-switch',
    handleStreamSwitch as EventListener,
  );
  railTabs.addEventListener(
    'stream-delete',
    handleStreamDelete as EventListener,
  );
}

let conversationWired = false;

function wireConversation(): void {
  if (conversationWired) return;
  conversationWired = true;
  conversationView.addEventListener(
    'stream-switch',
    handleStreamSwitch as EventListener,
  );
  conversationView.addEventListener(
    'toolbar-command',
    handleToolbarCommand as EventListener,
  );
  conversationView.addEventListener(
    'permission-action',
    handlePermissionAction as EventListener,
  );
  conversationView.addEventListener(
    'file-action',
    handleFileAction as EventListener,
  );
  conversationView.addEventListener('compile-fixer-run', runCompileFixer);
  conversationView.addEventListener(
    'getting-started-action',
    handleGettingStartedAction as EventListener,
  );
  conversationView.addEventListener(
    'followup-change',
    handleFollowUpChange as EventListener,
  );
  conversationView.addEventListener(
    'followup-send',
    handleFollowUpSend as EventListener,
  );
  conversationView.addEventListener('followup-polish', handleFollowUpPolish);
  // followup-focus-complete: clear the focus/polish/transcribe trigger flags.
  conversationView.addEventListener(
    'followup-focus-complete',
    handleFollowUpFocusComplete,
  );
}

if (!bootstrapFailed) {
  wireRailTabs();
  wireConversation();
  postMessage(DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE);
  postWebviewReady();
  if (hasWorkspace) void editorPane.refresh();
  document.body.dataset.desktopReady = 'true';
}

// Sole owner of "the workspace has unsaved editor changes": the main process
// keeps no copy and learns of it only when this veto raises will-prevent-unload.
window.addEventListener('beforeunload', (event) => {
  if (!editorPane.hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener(
  'unload',
  () => {
    surfaceResizeObserver?.disconnect();
    disposeShortcutHints?.();
    shortcutRegistry?.dispose();
    editorPane.dispose();
    terminalPane.disposeAll();
  },
  { once: true },
);

function postWebviewReady(): void {
  // The desktop main process expects `WEBVIEW_READY` from both the 'main' and
  // 'progress' views to drive startup messages and a full progress sync; this
  // single renderer plays both roles.
  postMessage(COMMON_COMMANDS.WEBVIEW_READY, { view: 'main' });
  postMessage(COMMON_COMMANDS.WEBVIEW_READY, { view: 'progress' });
}

function applyDesktopTheme(theme: DesktopThemeKind): void {
  applyHostBodyTheme(theme);
  reviewPane.setTheme(theme);
}
