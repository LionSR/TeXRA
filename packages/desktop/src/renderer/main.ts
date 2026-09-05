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
import { z } from 'zod';
import '@progressView/frontend/ProgressApp';
import './TexraDiffView';
import type { ProgressApp } from '@progressView/frontend/ProgressApp';
import '@settingsView/frontend';
import { hostBridge, postMessage } from '@shared/hostBridge';
import { DESKTOP_THEME_KIND } from '@shared/schemas';
import { resolvePostMessageTargetOrigin } from '@shared/postMessageOrigin';
import { applyShellAction, type Shell } from '@shared/session/shell';
import { emptySurface } from '@shared/session/surface';
import { PersistedState } from '@shared/state/PersistedState';

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
import {
  conversationDockTemplate,
  paperChipTemplate,
  taskSidebarTemplate,
  type RailPaper,
} from './taskShell';
import { subagentsPaneTemplate } from './subagentsPane';
import {
  activeWorkbenchTab,
  initialDesktopTaskShellState,
  openWorkbenchTab,
  renameWorkbenchTab,
  setBottomPanelHeight,
  setSidebarWidth,
  setWorkbenchTabDirty,
  setWorkbenchWidth,
  toggleFiles,
  togglePapersLayout,
  toggleSidebar,
  toggleSummaryBar,
  workspaceName,
  type DesktopTaskShellState,
  type WorkbenchTab,
} from '../shared/desktopTaskShell';
import { DESKTOP_WORKSPACE_COMMANDS } from '../shared/desktopWorkspaceMessages';
import {
  DESKTOP_PAPER_COMMANDS,
  type DesktopPaperDisplay,
} from '../shared/desktopPaperMessages';
import { isSafeAbsolutePdfPath } from '../shared/desktopPdfMessages';
import { getRendererPlatform } from './rendererPlatform';
import { createPdfPane } from './pdfPane';
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
import { createPaperSessions, rendererStateStore } from './paperSessions';

const appRoot = document.querySelector<HTMLElement>('#app')!;

if (appRoot == null) {
  throw new Error('TeXRA desktop renderer root was not found.');
}

// The theme is the renderer's own environment: Chromium follows the OS
// (and Electron's `nativeTheme`) through these media queries, so no host
// message carries it.
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const forcedColors = window.matchMedia('(forced-colors: active)');
function currentTheme() {
  if (forcedColors.matches) return DESKTOP_THEME_KIND.HIGH_CONTRAST;
  return darkScheme.matches
    ? DESKTOP_THEME_KIND.DARK
    : DESKTOP_THEME_KIND.LIGHT;
}
function applyTheme(): void {
  const theme = currentTheme();
  applyHostBodyTheme(theme);
  reviewPane.setTheme(theme);
}
darkScheme.addEventListener('change', applyTheme);
forcedColors.addEventListener('change', applyTheme);
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

// The renderer's own state store: interaction state survives a reload.
const rendererState = rendererStateStore(window.localStorage);
// The one Shell of this window (PRD 9): which papers are open and which one
// the window shows come from the main process; the collapsed set is the
// rail's own and persists. Until the first papers report the launcher is
// assumed usable so the empty state does not flash before the papers arrive.
const persistedShell = new PersistedState(
  rendererState,
  'shell',
  z.object({ collapsed: z.array(z.string()).prefault([]) }),
);
let shell: Shell = {
  active: '',
  open: [],
  collapsed: persistedShell.getState().collapsed,
  search: '',
};
let papersKnown = false;
// The display record of every open paper, as the main process produced it
// (PRD 8.1); the no-workspace session is never among them.
let paperDisplays: ReadonlyMap<string, DesktopPaperDisplay> = new Map();
const activePaperRoot = () => paperDisplays.get(shell.active)?.root;
const hasWorkspace = () => !papersKnown || activePaperRoot() !== undefined;
function setShell(next: Shell): void {
  shell = next;
  persistedShell.setState({ collapsed: [...next.collapsed] });
  rerenderShell();
}
// One fold, one surface, and one host snapshot per open paper, on the one
// webview runtime; the rail, the conversation shell, the palette, and the
// chrome read those three records and nothing else.
const paperSessions = createPaperSessions({ storage: rendererState });
paperSessions.onChange(rerenderShell);
// A paper whose session is not open yet is not listed: the rail shows what
// is known.
const railPapers = (): RailPaper[] =>
  shell.open.flatMap((key) => {
    const display = paperDisplays.get(key);
    const session = paperSessions.get(key);
    if (!display || !session) return [];
    return [
      {
        display,
        view: session.view$.get(),
        surface: session.surface$.get(),
      },
    ];
  });
const activeRailPaper = (papers: readonly RailPaper[]) =>
  papers.find((paper) => paper.display.key === shell.active);
/** The active paper's streams in rail order, for the palette. */
const activeStreams = () => {
  const active = activeRailPaper(railPapers());
  if (!active) return [];
  return active.view.order.flatMap((id) => {
    const stream = active.view.streams.get(id);
    return stream ? [stream] : [];
  });
};
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

// `<settings-app>` and `<progress-app>` are instantiated once and slotted into
// the shell template via Lit's DOM-node interpolation, so Lit preserves their
// internal state across re-renders and tab switches.
const noWorkspacePlaceholder: HTMLElement = document.createElement('section');
{
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

// The one conversation shell both hosts render: its empty state is the
// launcher, its conversation branch the selected stream. `rerenderShell`
// hands it the active paper's session.
const conversationView = document.createElement('progress-app') as ProgressApp;
conversationView.setAttribute('data-desktop-view', 'progress');

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
applyTheme();
const pdfPane = createPdfPane();
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
  pdfPane,
  subagentsTemplate: () => {
    const papers = railPapers();
    const active = activeRailPaper(papers);
    return active
      ? subagentsPaneTemplate({
          view: active.view,
          surface: active.surface,
          selected: active.surface.selected,
        })
      : nothing;
  },
  settingsView,
  logsPane,
  getState: () => shellState,
  getWorkspacePath: activePaperRoot,
  updateShell,
  postMessage,
});

const environmentPopover = createEnvironmentPopover({
  getWorkbenchTabs: () => shellState.workbenchTabs,
  getChildStreamCount: () =>
    activeStreams().reduce((total, stream) => total + stream.rollup.total, 0),
  postMessage,
});

function taskConversationTemplate(): TemplateResult {
  const startupPanelVisible = startupTeamPanel.isVisible();
  const papers = railPapers();
  const activePaper = activeRailPaper(papers);
  // The sidebar is the only home for the rail's per-stream pending-approval
  // badge (StreamTabs.ts). Collapsing it removes that cue entirely, so a
  // call held at the approval gate — often on a workflow's child stream, not
  // the one on screen — can stall with zero visible affordance (#11511).
  // Surface the same signal on the toggle that reopens the rail.
  const hasPendingApproval = (activePaper?.view.rollup.waiting ?? 0) > 0;
  const sidebarCollapsedWithPendingApproval =
    shellState.sidebarCollapsed && hasPendingApproval;
  let sidebarToggleLabel = shellState.sidebarCollapsed
    ? 'Show sidebar'
    : 'Hide sidebar';
  if (sidebarCollapsedWithPendingApproval) {
    sidebarToggleLabel = 'Show sidebar - approval pending';
  }
  const workspacePath = activePaperRoot();
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
        ${
          // In the focus layout the rail's switcher is the paper's one home.
          shellState.papersLayout === 'sections' && papers.length > 0
            ? paperChipTemplate(papers, activePaper, selectPaper)
            : nothing
        }
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
        <section class="task-conversation-pane" data-pane="conversation">
          ${
            hasWorkspace()
              ? html`
                  <section
                    class="task-launcher-surface"
                    ?hidden=${startupPanelVisible}
                  >
                    ${conversationView} ${conversationDockTemplate()}
                  </section>
                `
              : noWorkspacePlaceholder
          }
          ${startupTeamPanel.template()}
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

function selectPaper(key: string): void {
  postMessage(DESKTOP_PAPER_COMMANDS.SELECT_PAPER, { key });
}

function shellTemplate(): TemplateResult {
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
            papers: railPapers(),
            shell,
            papersLayout: shellState.papersLayout,
            subagentsOpen: shellState.workbenchTabs.some(
              (tab) => tab.kind === 'subagents',
            ),
            commandsLabel: commandLabel(DESKTOP_COMMAND_PALETTE_ID),
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
            onSelectPaper: selectPaper,
            onClosePaper: (key) =>
              postMessage(DESKTOP_PAPER_COMMANDS.CLOSE_PAPER, { key }),
            onTogglePaperCollapsed: (key) =>
              setShell(
                applyShellAction(shell, {
                  kind: 'collapse',
                  session: key,
                  collapsed: !shell.collapsed.includes(key),
                }),
              ),
            onTogglePapersLayout: () =>
              updateShell(togglePapersLayout(shellState)),
            onOpenTerminal: () => workbench.openKind('terminal'),
            onOpenBrowser: () => workbench.openKind('browser'),
            onOpenSettings: () => workbench.openKind('settings'),
            onOpenLogs: () => workbench.openKind('logs'),
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
  const active = activeRailPaper(railPapers());
  const offScreen = (active?.view.approvals ?? [])
    .map((approval) => approval.streamId)
    .filter((id) => id !== active?.surface.selected);
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
  const active = activeRailPaper(railPapers());
  const session = active ? paperSessions.get(active.display.key) : undefined;
  conversationView.dataset.session = active?.display.key ?? '';
  conversationView.view = active?.view ?? null;
  conversationView.surface = active?.surface ?? null;
  conversationView.host = session?.host$.get() ?? null;
  conversationView.nowMs = Date.now();
  render(shellTemplate(), appRoot);
  logsController.setActive(
    activeWorkbenchTab(shellState, 'right')?.kind === 'logs' ||
      activeWorkbenchTab(shellState, 'bottom')?.kind === 'logs',
  );
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
    // Recovery redoes the whole normal bootstrap tail; without it the
    // recovered shell renders but stays inert (rail clicks ignored).
    completeBootstrap();
  } catch (recoveryError) {
    console.error('TeXRA desktop renderer recovery failed', recoveryError);
    bootstrapFailed = true;
    renderBootstrapFallback(recoveryError);
  }
}

// =============================================================================
// Bootstrap
// =============================================================================

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
  resetMainView: resetLauncher,
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

// Clear the active stream so the conversation shell shows its empty state.
function returnToLauncher(): void {
  paperSessions.act(shell.active, { kind: 'selectNew' });
}

// The launcher's selections back to their defaults, and the empty state.
function resetLauncher(): void {
  paperSessions.act(shell.active, {
    kind: 'launch',
    patch: emptySurface(shell.active).launch,
  });
  returnToLauncher();
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
  resetLauncher,
  openKind: workbench.openKind,
  toggleLayoutPanel: (panel) => LAYOUT_PANEL_TOGGLES[panel](),
  onboarding: {
    show: () => startupTeamPanel.show(),
    hide: () => startupTeamPanel.hide(),
  },
  logs: { applySnapshot: (message) => logsController.applySnapshot(message) },
  review: {
    open: (message) => reviewPane.open(message),
    clear: () => reviewPane.clear(),
  },
  disposeReviewTab: () => workbench.disposeWorkbenchTab('workbench:review'),
  pdf: {
    open: (message) => {
      // The schema parsed the shape; the path is still checked once here,
      // before it becomes an iframe `src`, so a main-process post cannot
      // turn the tab into a generic browsing surface.
      if (!isSafeAbsolutePdfPath(message.pdfPath)) {
        console.error('[desktop] rejected unsafe PDF path', message.pdfPath);
        return;
      }
      updateShell(
        openWorkbenchTab(shellState, {
          kind: 'pdf',
          target: message.pdfPath,
          title: message.title,
        }),
      );
    },
    close: () => {
      for (const tab of shellState.workbenchTabs) {
        if (tab.kind === 'pdf') workbench.disposeWorkbenchTab(tab.id);
      }
    },
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
  papers: (message) => {
    const previousRoot = activePaperRoot();
    paperDisplays = new Map(
      message.papers.map((paper) => [paper.key, paper] as const),
    );
    papersKnown = true;
    const open = message.papers.map((paper) => paper.key);
    paperSessions.sync(open);
    setShell({
      ...shell,
      active: message.activeKey,
      open,
      collapsed: shell.collapsed.filter((key) => open.includes(key)),
    });
    const root = activePaperRoot();
    if (root !== undefined && root !== previousRoot) {
      void editorPane.refresh();
    }
  },
  environment: (summary) => {
    environmentPopover.set(summary);
    rerenderShell();
  },
});

// Every other message is the progress view's: the mounted <progress-app>
// is its one sink (BaseWebviewApp's window listener).
window.addEventListener('message', (event) => {
  for (const route of MESSAGE_ROUTES) {
    if (route(event.data)) return;
  }
});

// Keep the embedded browser aligned when the window resizes: its view is
// positioned in absolute window coordinates, not renderer layout.
window.addEventListener('resize', () => {
  workbench.syncBrowserViewBounds();
  editorPane.layout();
  terminalPane.layout();
});

// =============================================================================
// Shell events: the identity translation of PRD 8
// =============================================================================
//
// Every component dispatches the arm it wants as a bubbling, composed event
// (`uiEvents.ts`); the root forwards it to the paper it came from. The paper
// is the nearest `data-session` on the event's path: the conversation shell
// carries the shown paper's key and every rail tree its own.

// The guard below protects the wiring against double-registration: a
// bootstrap recovery attempt that itself fails re-renders the same fallback
// UI, whose button re-invokes recoverFromBootstrapFallback() against this
// same module-level document, which is never torn down for the life of the
// renderer.
let shellEventsWired = false;

function sessionOf(event: Event): string | undefined {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLElement && node.dataset.session) {
      return node.dataset.session;
    }
  }
  return undefined;
}

function wireShellEvents(): void {
  if (shellEventsWired) return;
  shellEventsWired = true;
  appRoot.addEventListener('runtime-request', (event) => {
    const key = sessionOf(event);
    if (key) paperSessions.runtimeRequest(key, event.detail);
  });
  appRoot.addEventListener('host-request', (event) => {
    const key = sessionOf(event);
    if (key) paperSessions.hostRequest(key, event.detail);
  });
  appRoot.addEventListener('surface-action', (event) => {
    const key = sessionOf(event);
    if (key) paperSessions.act(key, event.detail);
  });
}

/**
 * Everything "finish starting up" means, in one place: the module-scope path
 * below and `recoverFromBootstrapFallback` both run it, so the two can no
 * longer drift (recovery used to skip the workspace file refresh and never
 * installed shortcuts at all). Every step is idempotent.
 */
function completeBootstrap(): void {
  wireShellEvents();
  // Runs here rather than at module scope so a shell recovering from a
  // bootstrap failure re-installs shortcuts too; every step is idempotent.
  shortcutBootstrap.ensure();
  postMessage(DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE);
  // The papers list arrives in reply; each paper's session subscribes as it
  // opens, and the file tree refreshes when the list names the paper this
  // window shows.
  postMessage(DESKTOP_PAPER_COMMANDS.REQUEST_PAPERS);
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
    paperSessions.dispose();
  },
  { once: true },
);
