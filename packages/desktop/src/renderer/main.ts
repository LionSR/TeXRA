// Bundled product typeface. Imported before the token sheets so the faces are
// registered by the time --wa-font-family-body resolves. Geist carries the UI,
// JetBrains Mono the code/terminal/path surfaces; both are self-hosted rather
// than fetched, since the app must render identically offline.
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';

import './styles.css';
import './themeTokens.css';

import '@shared/wa';
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
  streamById$,
  streamStates$,
  topLevelStreams$,
} from '@progressView/frontend/progressState';
import { streamDisplayLabel } from '@progressView/frontend/utils';
import { COMMON_COMMANDS } from '@shared/ipc';
import '@settingsView/frontend';
import '@webview/frontend';
import { hostBridge, postMessage } from '@shared/hostBridge';
import type { StreamTabId } from '@shared/schemas';

import { Signal, subscribeToSignalChanges } from '@shared/signals';
import { resolvePostMessageTargetOrigin } from '@shared/postMessageOrigin';

import { formatDesktopAccelerator } from '@shared/commands/accelerators';

import { applyHostBodyTheme } from '@shared/wa/hostTheme';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { extractErrorMessage } from '@utils/errors/errorMessage';

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
import { createDesktopCommandPalette } from './desktopCommandPalette';
import { createDesktopShortcutBootstrap } from './desktopShortcutBootstrap';
import {
  createDesktopShortcutRegistry,
  desktopCommandPaletteShortcut,
  DESKTOP_COMMAND_PALETTE_ID,
} from './desktopShortcutRegistry';
import { createStartupTeamPanel } from './desktopOnboarding';
import { createEditorPane } from './editorPane';
import { installDesktopUnsavedCloseWiring } from './desktopUnsavedClose';
import { createTerminalPane } from './terminalPane';
import './taskShell.css';
import { taskSidebarTemplate } from './taskShell';
import {
  activeWorkbenchTab,
  initialDesktopTaskShellState,
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
  workspaceInitials,
  workspaceName,
  type DesktopTaskShellState,
  type WorkbenchTab,
} from '../shared/desktopTaskShell';
import { DESKTOP_WORKSPACE_COMMANDS } from '../shared/desktopWorkspaceMessages';
import { getRendererPlatform } from './rendererPlatform';
import { createPdfOverlay } from './pdfOverlay';
import { createReviewPane } from './reviewPane';
import { createDesktopPromptOverlay } from './promptOverlay';
import { createLogsPane } from './logsPane';
import { createEnvironmentPopover } from './environmentPopover';
import { createWorkbenchController } from './workbenchController';
import {
  disposePendingFileRequests,
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
  openMultiAgent: () => openSettingsTab('multi-agent'),
  // Lazy by necessity: the panel is constructed above the shortcut bootstrap's
  // declaration (which lands much later at module scope), so an eager or
  // captured read is a TDZ throw, and a bootstrap failure leaves its registry
  // absent until a recovery installs it. Reading at render time is also what
  // lets a user override (registry `localStorage`) reach the hint; the
  // construction-time default only ever printed cmd/ctrl+K.
  commandsHint: () => {
    const entry = shortcutBootstrap
      .entries()
      ?.find((entry) => entry.id === DESKTOP_COMMAND_PALETTE_ID);
    const accelerator = formatDesktopAccelerator(
      entry
        ? entry.accelerator
        : desktopCommandPaletteShortcut(rendererPlatform).accelerator,
      rendererPlatform,
    );
    return accelerator ? ` (${accelerator})` : '';
  },
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

function updateShell(next: DesktopTaskShellState): void {
  if (next === shellState) return;
  const previousActiveTabIds = shellState.activeWorkbenchTabIds;
  const previousBottomPanelHeight = shellState.bottomPanelHeight;
  const previousSidebarWidth = shellState.sidebarWidth;
  const previousWorkbenchWidth = shellState.workbenchWidth;
  shellState = next;
  rerenderShell();
  workbench.syncBrowserViewBounds();
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
    workbench.layoutVisibleSurfaces({ focus: activeTabChanged });
  }
}

function toggleBottomBarVisibility(): void {
  workbench.togglePlacementVisibility('bottom', 'terminal');
}

function toggleSidePanelVisibility(): void {
  workbench.togglePlacementVisibility('right', 'settings');
}

function toggleSummaryBarVisibility(): void {
  environmentPopover.close();
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

const terminalPane = createTerminalPane({
  start: (sessionId, cols, rows) => {
    // Reads the workbench controller declared below lazily: start() only fires
    // once a terminal session opens, well after module evaluation.
    const initialCommand = workbench.takePendingTerminalCommand(sessionId);
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
// ./fileRequests.ts; workbench tab lifecycle, surface layout, and browser-view
// bounds live in ./workbenchController.ts.

const workbench = createWorkbenchController({
  editorPane,
  terminalPane,
  reviewPane,
  settingsView,
  logsPane,
  getState: () => shellState,
  updateShell,
  postMessage,
});

const environmentPopover = createEnvironmentPopover({
  getWorkbenchTabs: () => shellState.workbenchTabs,
  getChildStreamCount: () =>
    [...childStreamsByParent$.get().values()].reduce(
      (total, children) => total + children.length,
      0,
    ),
  postMessage,
});

function currentTaskTitle(): string {
  // The confirmed stream id, not `displayedActiveStreamId$`: the header names
  // the content that is actually active while the rail highlights the pending
  // switch (see `progressState.ts`). `streamDisplayLabel` reads the label
  // `buildStreamTabInfo` already cleaned, so a source-prefixed agent id never
  // reaches the header.
  const activeId = activeStreamId$.get();
  const stream = activeId ? streamById$.get().get(activeId) : undefined;
  return streamDisplayLabel(stream) || 'New task';
}

function taskConversationTemplate(): TemplateResult {
  const activeId = activeStreamId$.get();
  const showConversation = activeId != null && hasAnyStreams$.get();
  const startupPanelVisible = startupTeamPanel.isVisible();
  // The sidebar is the only home for the rail's per-stream pending-approval
  // badge (StreamTabs.ts). Collapsing it removes that cue entirely, so a
  // call held at the approval gate — often on a workflow's child stream, not
  // the one on screen — can stall with zero visible affordance (#11511).
  // Surface the same signal on the toggle that reopens the rail.
  const hasPendingApproval = pendingApprovalIds$.get().size > 0;
  const sidebarCollapsedWithPendingApproval =
    shellState.sidebarCollapsed && hasPendingApproval;
  let sidebarToggleLabel = shellState.sidebarCollapsed
    ? 'Show sidebar'
    : 'Hide sidebar';
  if (sidebarCollapsedWithPendingApproval) {
    sidebarToggleLabel = 'Show sidebar - approval pending';
  }
  const workspacePath = window.texraDesktop?.workspacePath;
  // Names the button even when the ≤560px container query collapses it to the
  // icon: the shadow button then has no visible text, so only `title` reaches
  // its accessible name.
  const environmentButtonLabel = `${workspaceName(workspacePath)} environment`;
  return html`
    <main class="task-conversation" aria-label="Task conversation">
      <header class="task-header">
        <span class="task-header-button-slot">
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
          ${
            sidebarCollapsedWithPendingApproval
              ? html`<span
                  class="task-header-pending-approval-badge"
                  aria-hidden="true"
                ></span>`
              : nothing
          }
        </span>
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
                  <span>${workspaceName(workspacePath)}</span>
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
            ? environmentPopover.template(workspacePath)
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
        ${workbench.template(rightTab, 'right')}
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
        ${workbench.template(bottomTab, 'bottom')}
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
            streamCount: topLevelStreams$.get().length,
            workspaceName: workspaceName(workspacePath),
            commandsLabel: commandLabel(DESKTOP_COMMAND_PALETTE_ID),
            workspacePath,
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
            onOpenTerminal: () => workbench.openKind('terminal'),
            onOpenBrowser: () => workbench.openKind('browser'),
            onOpenSettings: () => workbench.openKind('settings'),
            onOpenLogs: () => workbench.openKind('logs'),
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
    workbench.syncBrowserViewBounds();
  });
  surfaceResizeObserver.disconnect();
  for (const element of document.querySelectorAll(
    '.task-conversation, .task-workbench',
  )) {
    surfaceResizeObserver.observe(element);
  }
}

/**
 * Streams whose off-screen pending approval has already reopened the
 * sidebar once. A user who re-collapses it mid-run must not be fought on
 * every unrelated signal change — only a newly appearing off-screen
 * approval (one not in this set) reopens it again.
 */
let sidebarRevealedForApprovalIds = new Set<string>();

/**
 * Auto-reveals a collapsed sidebar when a pending approval lands on a
 * stream other than the one on screen. That is the dead-end case: the
 * request card lives on the pending stream's own view (one home for the
 * decision), so a collapsed, non-viewed rail leaves nothing to click
 * (#11511 — per-call workflow review cards land on a child stream, not the
 * one the user is watching). Mutates `shellState` directly rather than going
 * through `updateShell` so this can run from inside `rerenderShell` without
 * recursing into another render pass.
 */
function revealSidebarForOffScreenApproval(): void {
  const offScreen = [...pendingApprovalIds$.get()].filter(
    (id) => id !== displayedActiveStreamId$.get(),
  );
  if (offScreen.length === 0) {
    sidebarRevealedForApprovalIds = new Set();
    return;
  }
  const isNewApproval = offScreen.some(
    (id) => !sidebarRevealedForApprovalIds.has(id),
  );
  sidebarRevealedForApprovalIds = new Set(offScreen);
  if (isNewApproval && shellState.sidebarCollapsed) {
    shellState = toggleSidebar(shellState);
  }
}

function rerenderShell(): void {
  if (bootstrapFailed) return;
  revealSidebarForOffScreenApproval();
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

function renderBootstrapFallback(error: unknown): void {
  const message =
    extractErrorMessage(error) ?? 'TeXRA could not finish starting up.';
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

function reportRuntimeFailure(error: unknown): void {
  const shouldReload = window.confirm(
    `TeXRA encountered an unexpected error.\n\n${extractErrorMessage(error) ?? 'TeXRA could not finish starting up.'}\n\nReload TeXRA now?`,
  );
  if (shouldReload) window.location.reload();
}

function recoverFromBootstrapFallback(): void {
  try {
    bootstrapFailed = false;
    bootstrapComplete = false;
    logsController.rerenderViewer();
    rerenderShell();
    // Recovery must install the signal watcher and then redo the whole normal
    // bootstrap tail. Without these the recovered shell renders but stays
    // inert (rail clicks ignored, signal changes don't trigger rerenders).
    installShellSignalWatcher();
    completeBootstrap();
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
  // (launcher ↔ conversation) and the rail tab properties stay live.
  // `subscribeToSignalChanges` wraps the same `Signal.subtle.Watcher` that
  // `SignalWatcher(LitElement)` uses internally, coalescing synchronous
  // signal writes into one microtask-scheduled re-render.
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
  subscribeToSignalChanges([shellDeps], rerenderShell);
  // Prime the dependency graph so the watcher knows what to listen for: an
  // unevaluated computed has no dependency set, so watching it alone would
  // never fire.
  shellDeps.get();
}

let bootstrapFailed = false;
let bootstrapComplete = false;
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  console.error('TeXRA desktop renderer unhandled rejection', event.reason);
  if (bootstrapComplete) {
    reportRuntimeFailure(event.reason);
    return;
  }
  bootstrapFailed = true;
  renderBootstrapFallback(event.reason);
});

try {
  logsController.rerenderViewer();
  rerenderShell();
  installShellSignalWatcher();
} catch (error) {
  bootstrapFailed = true;
  console.error('TeXRA desktop renderer bootstrap failed', error);
  renderBootstrapFallback(error);
}

// =============================================================================
// Settings
// =============================================================================
//
// Settings is a tab, not a modal dialog: configuring a run while watching it is
// the common case, which an overlay would make mutually exclusive.

type ShowSettingsArgs = Parameters<DesktopCommandActions['showSettings']>;

function openSettingsTab(
  tab?: ShowSettingsArgs[0],
  agentSubTab?: ShowSettingsArgs[1],
): void {
  workbench.openKind('settings');
  if (tab == null) return;
  window.postMessage(
    buildDesktopSettingsTabMessage(tab, agentSubTab),
    resolvePostMessageTargetOrigin(window.location.origin),
  );
}

// =============================================================================
// Onboarding + command palette
// =============================================================================

const desktopRendererCommandActions: DesktopCommandActions = {
  showLauncher: returnToLauncher,
  openWorkbench: workbench.openKind,
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
const shortcutBootstrap = createDesktopShortcutBootstrap({
  createRegistry: (openCommands) =>
    createDesktopShortcutRegistry({
      document,
      actions: desktopRendererCommandActions,
      openCommands,
    }),
  createPalette: (registry) =>
    createDesktopCommandPalette({
      document,
      actions: desktopRendererCommandActions,
      getStreams: () => topLevelStreams$.get(),
      getShortcuts: () => registry.entries(),
    }),
  appendPalette: (element) => document.body.append(element),
  onShortcutsChanged: (entries) => {
    shortcutAcceleratorsById.clear();
    for (const entry of entries) {
      shortcutAcceleratorsById.set(entry.id, entry.accelerator);
    }
    rerenderShell();
  },
});

function openCommandPalette(): void {
  shortcutBootstrap.open();
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

const MESSAGE_ROUTES = createMessageRoutes({
  saveAllFiles: () => {
    void editorPane.save();
  },
  // `refresh()` re-lists from the root and drops the expansion state, which is
  // the same reset the Files rail already performs each time it is opened —
  // so this stays consistent with how the pane behaves everywhere else rather
  // than introducing a second, subtler kind of refresh.
  reloadWorkspaceFiles: () => {
    void editorPane.refresh();
  },
  isBootstrapFailed: () => bootstrapFailed,
  returnToLauncher,
  openKind: workbench.openKind,
  toggleLayoutPanel: (panel) => LAYOUT_PANEL_TOGGLES[panel](),
  onboarding: {
    show: () => startupTeamPanel.show(),
    hide: () => startupTeamPanel.hide(),
  },
  applyTheme(theme) {
    applyHostBodyTheme(theme);
    reviewPane.setTheme(theme);
  },
  logs: { applySnapshot: (message) => logsController.applySnapshot(message) },
  review: {
    open: (message) => reviewPane.open(message),
    clear: () => reviewPane.clear(),
  },
  disposeReviewTab: () => workbench.disposeWorkbenchTab('workbench:review'),
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
  openTerminalCommand: workbench.openTerminalCommand,
  renameBrowserTab: (tabId, title) =>
    updateShell(renameWorkbenchTab(shellState, tabId, title)),
  environment: {
    set: (summary, loading) => environmentPopover.set(summary, loading),
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
  workbench.syncBrowserViewBounds();
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

const CONVERSATION_EVENTS: ReadonlyArray<[string, EventListener]> = [
  ['stream-switch', handleStreamSwitch as EventListener],
  ['toolbar-command', handleToolbarCommand as EventListener],
  ['permission-action', handlePermissionAction as EventListener],
  ['file-action', handleFileAction as EventListener],
  ['compile-fixer-run', runCompileFixer as EventListener],
  ['getting-started-action', handleGettingStartedAction as EventListener],
  ['followup-change', handleFollowUpChange as EventListener],
  ['followup-send', handleFollowUpSend as EventListener],
  ['followup-polish', handleFollowUpPolish as EventListener],
  // followup-focus-complete clears the focus/polish/transcribe trigger flags.
  ['followup-focus-complete', handleFollowUpFocusComplete as EventListener],
];

function wireConversation(): void {
  if (conversationWired) return;
  conversationWired = true;
  for (const [event, handler] of CONVERSATION_EVENTS) {
    conversationView.addEventListener(event, handler);
  }
}

/**
 * Everything "finish starting up" means, in one place: the module-scope path
 * below and `recoverFromBootstrapFallback` both run it, so the two can no
 * longer drift (recovery used to skip the workspace file refresh and never
 * installed shortcuts at all). Every step is idempotent.
 */
function completeBootstrap(): void {
  wireRailTabs();
  wireConversation();
  // Runs here rather than at module scope so a shell recovering from a
  // bootstrap failure re-installs shortcuts too; every step is idempotent.
  shortcutBootstrap.ensure();
  postMessage(DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE);
  postWebviewReady();
  if (hasWorkspace) void editorPane.refresh();
  document.body.dataset.desktopReady = 'true';
  bootstrapComplete = true;
}

if (!bootstrapFailed) {
  completeBootstrap();
}

// Sole owner of "the workspace has unsaved editor changes": the main process
// keeps no copy and learns of it only when this veto raises will-prevent-unload.
installDesktopUnsavedCloseWiring(window, editorPane);

window.addEventListener(
  'unload',
  () => {
    surfaceResizeObserver?.disconnect();
    shortcutBootstrap.dispose();
    disposePendingFileRequests();
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
