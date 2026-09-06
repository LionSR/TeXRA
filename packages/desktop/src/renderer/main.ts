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
import { repeat } from 'lit/directives/repeat.js';
import { z } from 'zod';
import '@progressView/frontend/ProgressApp';
import './TexraDiffView';
import type { StateStore } from '@platform/interfaces';
import type { ProgressApp } from '@progressView/frontend/ProgressApp';
import { createSessionSurfaces } from '@progressView/frontend/sessionSurfaces';
import '@settingsView/frontend';
import { hostBridge, postMessage } from '@shared/hostBridge';
import { DESKTOP_THEME_KIND } from '@shared/schemas';
import { resolvePostMessageTargetOrigin } from '@shared/postMessageOrigin';
import { applyShellAction, type Shell } from '@shared/session/shell';
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
import { installDesktopUnsavedCloseWiring } from './desktopUnsavedClose';
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
  setWorkbenchWidth,
  toggleFiles,
  togglePapersLayout,
  toggleSidebar,
  toggleSummaryBar,
  workspaceName,
  type DesktopTaskShellState,
  type WorkbenchTab,
  type WorkbenchPlacement,
} from '../shared/desktopTaskShell';
import { DESKTOP_WORKSPACE_COMMANDS } from '../shared/desktopWorkspaceMessages';
import { DESKTOP_PAPER_COMMANDS } from '../shared/desktopPaperMessages';
import { isSafeAbsolutePdfPath } from '../shared/desktopPdfMessages';
import { getRendererPlatform } from './rendererPlatform';
import { createDesktopPromptOverlay } from './promptOverlay';
import { createLogsPane } from './logsPane';
import { createEnvironmentPopover } from './environmentPopover';
import { disposePendingFileRequests } from './fileRequests';
import { createPaperWorkbench } from './paperWorkbench';
import { createMessageRoutes } from './messageRoutes';

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
  for (const paper of paperWorkbenches.values()) paper.setTheme(theme);
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

// The renderer's own interaction state survives a reload in
// `localStorage`; the preload bridge's `getState` is in-memory only.
const rendererState: StateStore = {
  get<T>(key: string, defaultValue?: T): T {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return defaultValue as T;
    return JSON.parse(raw) as T;
  },
  update(key, value) {
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
    return Promise.resolve();
  },
};
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
let applyingPaperList = false;
// The folder of every open paper, by session key; the no-workspace session
// is never among them. How a paper is named is its host snapshot's.
let paperRoots: ReadonlyMap<string, string> = new Map();
const activePaperRoot = () => paperRoots.get(shell.active);
const hasWorkspace = () => !papersKnown || activePaperRoot() !== undefined;
function setShell(next: Shell): void {
  shell = next;
  persistedShell.setState({ collapsed: [...next.collapsed] });
  rerenderShell();
}
// One fold, one surface, and one host snapshot per open paper, on the one
// webview runtime; the rail, the conversation shell, the palette, and the
// chrome read those three records and nothing else.
const paperSessions = createSessionSurfaces({ storage: rendererState });
paperSessions.onChange(rerenderShell);
// A paper whose session has not framed its host snapshot yet is not listed:
// the rail shows what is known.
const railPapers = (): RailPaper[] =>
  shell.open.flatMap((key) => {
    const session = paperSessions.get(key);
    const display = session?.host$.get()?.paper;
    if (!session || !display) return [];
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

const paperWorkbenches = new Map<
  string,
  ReturnType<typeof createPaperWorkbench>
>();

function currentWorkbench() {
  const paper = paperWorkbenches.get(shell.active);
  if (!paper) throw new Error(`No workbench for paper ${shell.active}.`);
  return paper;
}

function shellState(): DesktopTaskShellState {
  return (
    paperWorkbenches.get(shell.active)?.getState() ??
    initialDesktopTaskShellState()
  );
}

function updateShell(next: DesktopTaskShellState): void {
  currentWorkbench().updateState(next);
}

function layoutChanged(
  session: string,
  previous: DesktopTaskShellState,
  next: DesktopTaskShellState,
): void {
  if (session !== shell.active || applyingPaperList) return;
  rerenderShell();
  currentWorkbench().workbench.syncBrowserViewBounds();
  const activeTabChanged =
    previous.activeWorkbenchTabIds.right !== next.activeWorkbenchTabIds.right ||
    previous.activeWorkbenchTabIds.bottom !== next.activeWorkbenchTabIds.bottom;
  if (
    activeTabChanged ||
    previous.bottomPanelHeight !== next.bottomPanelHeight ||
    previous.sidebarWidth !== next.sidebarWidth ||
    previous.workbenchWidth !== next.workbenchWidth
  ) {
    currentWorkbench().workbench.layoutVisibleSurfaces({
      focus: activeTabChanged,
    });
  }
}

function toggleBottomBarVisibility(): void {
  currentWorkbench().workbench.togglePlacementVisibility('bottom', 'terminal');
}

function toggleSidePanelVisibility(): void {
  currentWorkbench().workbench.togglePlacementVisibility('right', 'settings');
}

function toggleSummaryBarVisibility(): void {
  environmentPopover.close();
  updateShell(toggleSummaryBar(shellState()));
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
conversationView.placement = 'desktop';
conversationView.setAttribute('data-desktop-view', 'progress');

const settingsView: HTMLElement = document.createElement('settings-app');
settingsView.setAttribute('data-desktop-view', 'settings');

// The logs viewer is hosted directly in its workbench tab body.
const logsController = createLogsPane();
const logsPane = logsController.element;

const promptOverlay = createDesktopPromptOverlay(appRoot, (message) =>
  hostBridge.postMessage(message),
);
applyTheme();

const environmentPopover = createEnvironmentPopover({
  getWorkbenchTabs: () => shellState().workbenchTabs,
  getChildStreamCount: () =>
    activeStreams().reduce((total, stream) => total + stream.rollup.total, 0),
  postMessage: (command, payload) =>
    postMessage(command, { ...payload, session: shell.active }),
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
    shellState().sidebarCollapsed && hasPendingApproval;
  let sidebarToggleLabel = shellState().sidebarCollapsed
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
            @click=${() => updateShell(toggleSidebar(shellState()))}
          >
            ${waIcon(
              shellState().sidebarCollapsed ? 'chevron-right' : 'chevron-left',
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
          shellState().papersLayout === 'sections' && papers.length > 0
            ? paperChipTemplate(papers, activePaper, selectPaper)
            : nothing
        }
        <span class="task-header-spacer"></span>
        ${
          shellState().summaryBarVisible
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
            pressed: shellState().summaryBarVisible,
            onClick: toggleSummaryBarVisibility,
          })}
          ${renderIconActionButton({
            id: 'taskToggleBottomBar',
            icon: 'window-maximize',
            label: commandLabel(DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR),
            tooltip: commandTitle(DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR),
            className: 'task-layout-toggle',
            size: 'l',
            pressed: activeWorkbenchTab(shellState(), 'bottom') != null,
            onClick: toggleBottomBarVisibility,
          })}
          ${renderIconActionButton({
            id: 'taskToggleSidePanel',
            icon: 'picture-in-picture',
            label: commandLabel(DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL),
            tooltip: commandTitle(DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL),
            className: 'task-layout-toggle',
            size: 'l',
            pressed: activeWorkbenchTab(shellState(), 'right') != null,
            onClick: toggleSidePanelVisibility,
          })}
        </div>
        ${
          shellState().summaryBarVisible
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
 * Store the split handle's measured size on this paper's surface.
 */
function recordLayoutMeasurement(next: DesktopTaskShellState): void {
  if (applyingPaperList) return;
  paperWorkbenches.get(shell.active)?.updateState(next);
}

function rememberSidebarWidth(event: Event): void {
  if (shellState().sidebarCollapsed) return;
  const width = (event.currentTarget as SplitPanelElement).positionInPixels;
  recordLayoutMeasurement(setSidebarWidth(shellState(), width));
}

function rememberBottomPanelHeight(event: Event): void {
  if (!activeWorkbenchTab(shellState(), 'bottom')) return;
  const height = (event.currentTarget as SplitPanelElement).positionInPixels;
  recordLayoutMeasurement(setBottomPanelHeight(shellState(), height));
}

function rememberWorkbenchWidth(event: Event): void {
  if (!activeWorkbenchTab(shellState(), 'right')) return;
  const width = (event.currentTarget as SplitPanelElement).positionInPixels;
  recordLayoutMeasurement(setWorkbenchWidth(shellState(), width));
}

function paperWorkbenchesTemplate(
  placement: WorkbenchPlacement,
): TemplateResult {
  return html`${repeat(
    paperWorkbenches.values(),
    (paper) => paper.session,
    (paper) =>
      html` <div
        class="task-paper-workbench"
        data-workbench-session=${paper.session}
        ?hidden=${paper.session !== shell.active || !activeWorkbenchTab(paper.getState(), placement)}
      >
        ${paper.workbench.template(placement)}
      </div>`,
  )} `;
}

function taskRightLayoutTemplate(
  rightTab: WorkbenchTab | undefined,
): TemplateResult {
  return html`
    <wa-split-panel
      class="task-main-split"
      orientation="horizontal"
      primary="end"
      position-in-pixels=${rightTab ? shellState().workbenchWidth : 0}
      ?disabled=${!rightTab}
      style=${rightTab ? nothing : '--divider-width: 0px'}
      @wa-reposition=${rememberWorkbenchWidth}
    >
      <span slot="divider" class="task-split-handle">
        ${waIcon('ellipsis')}
      </span>
      <div slot="start" class="task-main-panel">
        ${taskConversationTemplate()}
      </div>
      <div slot="end" class="task-workbench-panel">
        ${paperWorkbenchesTemplate('right')}
      </div>
    </wa-split-panel>
  `;
}

function taskMainTemplate(
  rightTab: WorkbenchTab | undefined,
  bottomTab: WorkbenchTab | undefined,
): TemplateResult {
  const rightLayout = taskRightLayoutTemplate(rightTab);
  return html`
    <wa-split-panel
      class="task-bottom-split"
      orientation="vertical"
      primary="end"
      position-in-pixels=${bottomTab ? shellState().bottomPanelHeight : 0}
      ?disabled=${!bottomTab}
      style=${bottomTab ? nothing : '--divider-width: 0px'}
      @wa-reposition=${rememberBottomPanelHeight}
    >
      <span slot="divider" class="task-bottom-split-handle">
        ${waIcon('ellipsis')}
      </span>
      <div slot="start" class="task-main-panel">${rightLayout}</div>
      <div slot="end" class="task-bottom-workbench-panel">
        ${paperWorkbenchesTemplate('bottom')}
      </div>
    </wa-split-panel>
  `;
}

function selectPaper(key: string): void {
  postMessage(DESKTOP_PAPER_COMMANDS.SELECT_PAPER, { key });
}

function shellTemplate(): TemplateResult {
  const rightTab = activeWorkbenchTab(shellState(), 'right');
  const bottomTab = activeWorkbenchTab(shellState(), 'bottom');
  const main = taskMainTemplate(rightTab, bottomTab);
  const workbenchOpen = rightTab != null || bottomTab != null;

  return html`
    <wa-split-panel
      class="task-shell ${shellState().sidebarCollapsed ? 'task-shell-collapsed' : ''}"
      orientation="horizontal"
      primary="start"
      .positionInPixels=${shellState().sidebarCollapsed ? 0 : shellState().sidebarWidth}
      ?disabled=${shellState().sidebarCollapsed}
      style=${shellState().sidebarCollapsed ? '--divider-width: 0px' : nothing}
      data-workbench-open=${String(workbenchOpen)}
      data-right-panel-open=${String(rightTab != null)}
      data-bottom-panel-open=${String(bottomTab != null)}
      @wa-reposition=${rememberSidebarWidth}
    >
      <span slot="divider" class="task-split-handle">
        ${waIcon('ellipsis')}
      </span>
      <div
        slot="start"
        class="task-sidebar-slot"
        ?hidden=${shellState().sidebarCollapsed}
      >
        ${taskSidebarTemplate(
          {
            files: currentWorkbench().editorPane.treeElement,
            filesExpanded: shellState().filesExpanded,
            papers: railPapers(),
            shell,
            papersLayout: shellState().papersLayout,
            commandsLabel: commandLabel(DESKTOP_COMMAND_PALETTE_ID),
          },
          {
            onNewTask: returnToLauncher,
            onSearch: openCommandPalette,
            onToggleFiles: () => {
              const next = toggleFiles(shellState());
              updateShell(next);
              if (next.filesExpanded)
                void currentWorkbench().editorPane.refresh();
            },
            onOpenFolder: () =>
              postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
            onSelectPaper: selectPaper,
            onClosePaper: (key) =>
              postMessage(DESKTOP_PAPER_COMMANDS.CLOSE_PAPER, {
                key,
                hasUnsavedChanges:
                  paperWorkbenches.get(key)?.editorPane.hasUnsavedChanges() ??
                  false,
              }),
            onTogglePaperCollapsed: (key) =>
              setShell(
                applyShellAction(shell, {
                  kind: 'collapse',
                  session: key,
                  collapsed: !shell.collapsed.includes(key),
                }),
              ),
            onTogglePapersLayout: () =>
              updateShell(togglePapersLayout(shellState())),
            onOpenTerminal: () =>
              currentWorkbench().workbench.openKind('terminal'),
            onOpenBrowser: () =>
              currentWorkbench().workbench.openKind('browser'),
            onOpenSettings: () =>
              currentWorkbench().workbench.openKind('settings'),
            onOpenLogs: () => currentWorkbench().workbench.openKind('logs'),
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
    const paper = paperWorkbenches.get(shell.active);
    if (!paper || applyingPaperList) return;
    paper.editorPane.layout();
    paper.terminalPane.layout();
    paper.workbench.syncBrowserViewBounds();
  });
  surfaceResizeObserver.disconnect();
  for (const element of document.querySelectorAll(
    '.task-conversation, .task-workbench',
  )) {
    surfaceResizeObserver.observe(element);
  }
}

/**
 * The off-screen pending approvals (by request id) that have already
 * reopened the sidebar once. A user who re-collapses it mid-run must not be
 * fought on every unrelated signal change; only a newly appearing off-screen
 * approval (one not in this set) reopens it again, including a new request
 * on a stream whose earlier one was answered.
 */
let sidebarRevealedForApprovalIds = new Set<string>();

/**
 * Auto-reveals a collapsed sidebar when a pending approval lands on a
 * stream other than the one on screen. That is the dead-end case: the
 * request card lives on the pending stream's own view (one home for the
 * decision), so a collapsed, non-viewed rail leaves nothing to click
 * (#11511 — per-call workflow review cards land on a child stream, not the
 * one the user is watching). The preference belongs to the paper's surface.
 */
function revealSidebarForOffScreenApproval(): void {
  const active = activeRailPaper(railPapers());
  const offScreen = (active?.view.approvals ?? [])
    .filter((approval) => approval.streamId !== active?.surface.selected)
    .map((approval) => approval.requestId);
  if (offScreen.length === 0) {
    sidebarRevealedForApprovalIds = new Set();
    return;
  }
  const isNewApproval = offScreen.some(
    (id) => !sidebarRevealedForApprovalIds.has(id),
  );
  sidebarRevealedForApprovalIds = new Set(offScreen);
  if (isNewApproval && shellState().sidebarCollapsed) {
    paperSessions.act(shell.active, {
      kind: 'workbench',
      layout: toggleSidebar(shellState()),
    });
  }
}

function rerenderShell(): void {
  if (bootstrapFailed || applyingPaperList) return;
  revealSidebarForOffScreenApproval();
  const active = activeRailPaper(railPapers());
  const session = active ? paperSessions.get(active.display.key) : undefined;
  conversationView.dataset.session = active?.display.key ?? '';
  conversationView.view = active?.view ?? null;
  conversationView.surface = active?.surface ?? null;
  conversationView.host = session?.host$.get() ?? null;
  conversationView.nowMs = Date.now();
  render(
    paperWorkbenches.has(shell.active)
      ? shellTemplate()
      : noWorkspacePlaceholder,
    appRoot,
  );
  logsController.setActive(
    activeWorkbenchTab(shellState(), 'right')?.kind === 'logs' ||
      activeWorkbenchTab(shellState(), 'bottom')?.kind === 'logs',
  );
  if (paperWorkbenches.has(shell.active)) observeSurfaceResizes();
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
  currentWorkbench().workbench.openKind('settings');
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
  openWorkbench: (kind) => currentWorkbench().workbench.openKind(kind),
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
    void currentWorkbench().editorPane.save();
  },
  showFirstRunWalkthrough: () => {
    startupTeamPanel.show();
  },
  toggleBottomBar: toggleBottomBarVisibility,
  toggleSidePanel: toggleSidePanelVisibility,
  toggleSummaryBar: toggleSummaryBarVisibility,
  // New Session is the header's "+" (PRD 12.4): the New-task state with
  // the launcher's selections as they are, the same as the extension.
  resetMainView: returnToLauncher,
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

const LAYOUT_PANEL_TOGGLES: Record<DesktopLayoutPanel, () => void> = {
  bottomBar: toggleBottomBarVisibility,
  sidePanel: toggleSidePanelVisibility,
  summaryBar: toggleSummaryBarVisibility,
};

const MESSAGE_ROUTES = createMessageRoutes({
  saveAllFiles: () => {
    void paperWorkbenches.get(shell.active)?.editorPane.save();
  },
  // `refresh()` re-lists from the root and drops the expansion state, which is
  // the same reset the Files rail already performs each time it is opened —
  // so this stays consistent with how the pane behaves everywhere else rather
  // than introducing a second, subtler kind of refresh.
  reloadWorkspaceFiles: (session) => {
    void paperWorkbenches.get(session)?.editorPane.refresh();
  },
  isBootstrapFailed: () => bootstrapFailed,
  returnToLauncher,
  openKind: (kind) =>
    paperWorkbenches.get(shell.active)?.workbench.openKind(kind),
  toggleLayoutPanel: (panel) => {
    if (paperWorkbenches.has(shell.active)) LAYOUT_PANEL_TOGGLES[panel]();
  },
  onboarding: {
    show: () => startupTeamPanel.show(),
    hide: () => startupTeamPanel.hide(),
  },
  logs: { applySnapshot: (message) => logsController.applySnapshot(message) },
  review: {
    open: (message) => {
      const paper = paperWorkbenches.get(message.session);
      paper?.reviewPane.open(message);
      paper?.workbench.openKind('review');
    },
    clear: (session) => paperWorkbenches.get(session)?.reviewPane.clear(),
  },
  disposeReviewTab: (session) =>
    paperWorkbenches
      .get(session)
      ?.workbench.disposeWorkbenchTab('workbench:review'),
  pdf: {
    open: (message) => {
      // The schema parsed the shape; the path is still checked once here,
      // before it becomes an iframe `src`, so a main-process post cannot
      // turn the tab into a generic browsing surface.
      if (!isSafeAbsolutePdfPath(message.pdfPath)) {
        console.error('[desktop] rejected unsafe PDF path', message.pdfPath);
        return;
      }
      const paper = paperWorkbenches.get(message.session);
      if (!paper) return;
      paper.updateState(
        openWorkbenchTab(paper.getState(), {
          kind: 'pdf',
          target: message.pdfPath,
          title: message.title,
        }),
      );
    },
    close: (session) => {
      const paper = paperWorkbenches.get(session);
      if (!paper) return;
      for (const tab of paper.getState().workbenchTabs) {
        if (tab.kind === 'pdf') paper.workbench.disposeWorkbenchTab(tab.id);
      }
    },
  },
  prompt: { open: (message) => promptOverlay.open(message) },
  terminal: {
    write: (session, sessionId, data) =>
      paperWorkbenches.get(session)?.terminalPane.write(sessionId, data),
    reportExit: (session, sessionId, exitCode) =>
      paperWorkbenches
        .get(session)
        ?.terminalPane.reportExit(sessionId, exitCode),
    reportError: (session, sessionId, message) =>
      paperWorkbenches
        .get(session)
        ?.terminalPane.reportError(sessionId, message),
  },
  openTerminalCommand: (session, command) =>
    paperWorkbenches.get(session)?.workbench.openTerminalCommand(command),
  renameBrowserTab: (session, tabId, title) => {
    const paper = paperWorkbenches.get(session);
    if (paper)
      paper.updateState(renameWorkbenchTab(paper.getState(), tabId, title));
  },
  papers: (message) => {
    const previousKey = shell.active;
    // The list changes resource ownership and selection together. Keep signal
    // notifications from painting an intermediate owner during this adoption.
    applyingPaperList = true;
    try {
      paperRoots = new Map(
        message.papers.map((paper) => [paper.key, paper.root] as const),
      );
      papersKnown = true;
      const open = message.papers.map((paper) => paper.key);
      const sessions = [...new Set([...open, message.activeKey])];
      for (const [key, paper] of paperWorkbenches) {
        if (sessions.includes(key)) continue;
        paper.dispose();
        paperWorkbenches.delete(key);
      }
      paperSessions.sync(sessions);
      for (const key of sessions) {
        if (paperWorkbenches.has(key)) continue;
        const paper = createPaperWorkbench({
          session: key,
          root: paperRoots.get(key),
          surfaces: paperSessions,
          settingsView,
          logsPane,
          isActive: () => shell.active === key,
          subagentsTemplate: () => {
            const session = paperSessions.get(key);
            return session
              ? subagentsPaneTemplate({
                  view: session.view$.get(),
                  surface: session.surface$.get(),
                  selected: session.surface$.get().selected,
                })
              : nothing;
          },
          onLayoutChanged: layoutChanged,
        });
        paperWorkbenches.set(key, paper);
        paper.setTheme(currentTheme());
        if (paperRoots.has(key)) void paper.editorPane.refresh();
      }
      setShell({
        ...shell,
        active: message.activeKey,
        open,
        collapsed: shell.collapsed.filter((key) => open.includes(key)),
      });
    } finally {
      applyingPaperList = false;
    }
    rerenderShell();
    if (previousKey !== message.activeKey) {
      environmentPopover.close();
      currentWorkbench().workbench.layoutVisibleSurfaces({ focus: false });
      currentWorkbench().workbench.syncBrowserViewBounds();
    }
  },
  environment: (session, summary) => {
    if (session !== shell.active) return;
    environmentPopover.set(summary);
    rerenderShell();
  },
});

// The shell's one message listener: the desktop routes first, then the
// session transport, which takes the frames, responses, and surface
// actions of every open paper's session. The settings view's pushes reach
// `<settings-app>` through its own listener and match no route here.
window.addEventListener('message', (event) => {
  for (const route of [...MESSAGE_ROUTES, paperSessions.receive]) {
    if (route(event.data)) return;
  }
});

// Keep the embedded browser aligned when the window resizes: its view is
// positioned in absolute window coordinates, not renderer layout.
window.addEventListener('resize', () => {
  const paper = paperWorkbenches.get(shell.active);
  if (!paper || applyingPaperList) return;
  paper.workbench.syncBrowserViewBounds();
  paper.editorPane.layout();
  paper.terminalPane.layout();
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
  appRoot.addEventListener('composer-submit', (event) => {
    const key = sessionOf(event);
    if (key) paperSessions.submit(key);
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
installDesktopUnsavedCloseWiring(window, {
  hasUnsavedChanges: () =>
    [...paperWorkbenches.values()].some((paper) =>
      paper.editorPane.hasUnsavedChanges(),
    ),
});

window.addEventListener(
  'unload',
  () => {
    surfaceResizeObserver?.disconnect();
    shortcutBootstrap.dispose();
    disposePendingFileRequests();
    for (const paper of paperWorkbenches.values()) paper.dispose();
    paperWorkbenches.clear();
    paperSessions.dispose();
  },
  { once: true },
);
