// Bundled product typeface. Imported before the token sheets so the faces are
// registered by the time --wa-font-family-body resolves. Geist carries the UI,
// JetBrains Mono the code/terminal/path surfaces; both are self-hosted rather
// than fetched, since the app must render identically offline.
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';

import './styles.css';
import './themeTokens.css';
import './designTokens';

import '@ui/wa';
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
import type { ProgressApp } from '@progressView/frontend/ProgressApp';
import { createSessionSurfaces } from '@progressView/frontend/sessionSurfaces';
import { hostBridge, postMessage } from '@shared/hostBridge';
import { DESKTOP_THEME_KIND } from '@shared/schemas';
import type { Shell } from '@shared/session/shell';
import {
  PersistedState,
  type KeyValueStore,
} from '@shared/state/PersistedState';

import { formatDesktopAccelerator } from '@shared/commands/accelerators';

import { applyHostBodyTheme } from '@ui/wa/hostTheme';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { TEXRA_TAGLINE } from '@ui/copy/onboarding';
import { extractErrorMessage } from '@utils/errors/errorMessage';

import { type DesktopLayoutPanel } from '../shared/desktopShellMessages';
import {
  DESKTOP_LOCAL_COMMANDS,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandId,
} from '../shared/desktopCommandSurface';
import { createDesktopCommandPalette } from './desktopCommandPalette';
import {
  createDesktopShortcutRegistry,
  desktopCommandPaletteShortcut,
  DESKTOP_COMMAND_PALETTE_ID,
} from './desktopShortcutRegistry';
import './desktopShell.css';
import { shellSidebarTemplate, type RailProject } from './desktopShell';
import {
  activeWorkbenchTab,
  initialDesktopShellState,
  openWorkbenchTab,
  renameWorkbenchTab,
  setBottomPanelHeight,
  setSidebarWidth,
  toggleSidebar,
  WORKBENCH_PLACEMENTS,
  type DesktopShellState,
  type WorkbenchTab,
  type WorkbenchPlacement,
} from '../shared/desktopShellState';
import { DESKTOP_PROJECT_COMMANDS } from '../shared/desktopProjectMessages';
import { resolveSessionWire } from '../shared/hostBridgeChannels';
import { getRendererPlatform } from './rendererPlatform';
import { createDesktopPromptOverlay } from './promptOverlay';
import { createDesktopSettingsDialog } from './settingsDialog';
import { trackNativeViewOverlays } from './nativeViewOverlays';
import { createLogsPane } from './logsPane';
import { createProjectWorkbench } from './projectWorkbench';
import { createProjectRail } from './projectRail';
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
  for (const project of projectWorkbenches.values()) project.setTheme(theme);
}
darkScheme.addEventListener('change', applyTheme);
forcedColors.addEventListener('change', applyTheme);

// =============================================================================
// Desktop shell
// =============================================================================
//
// The conversation is the permanent task canvas. Project navigation stays in
// the left sidebar, while files and tools share one optional right workbench.

// Renderer state survives a reload in `localStorage` (the preload `getState`
// is in-memory). Reads run at module load: unreadable storage or non-JSON
// falls back to the default, a refused write goes unsaved, both loudly.
const rendererState: KeyValueStore = {
  get<T>(key: string, defaultValue?: T): T {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return defaultValue as T;
      return JSON.parse(raw) as T;
    } catch (error) {
      console.warn(
        `[desktop] Saved renderer state "${key}" is unreadable; falling back to defaults.`,
        error,
      );
      return defaultValue as T;
    }
  },
  update(key, value) {
    try {
      if (value === undefined) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(
        `[desktop] Could not save renderer state "${key}"; it will not survive a reload.`,
        error,
      );
    }
  },
};
// The one Shell of this window (PRD 9): which projects are open and which one
// the window shows come from the main process; the collapsed set is the
// rail's own and persists. Until the first projects report the launcher is
// assumed usable so the empty state does not flash before the projects arrive.
const persistedShell = new PersistedState(
  rendererState,
  'shell',
  z.object({ collapsed: z.array(z.string()).prefault([]) }),
);
let shell: Shell = {
  active: '',
  open: [],
  collapsed: persistedShell.getState().collapsed,
};
let projectsKnown = false;
let applyingProjectList = false;
// The no-workspace session is never among the open projects; how a project
// is named is its host snapshot's.
const hasWorkspace = () => !projectsKnown || shell.open.includes(shell.active);
function setShell(next: Shell): void {
  shell = next;
  persistedShell.setState({ collapsed: [...next.collapsed] });
  rerenderShell();
}
// One fold, one surface, and one host snapshot per open project, on the one
// webview runtime; the rail, the conversation shell, the palette, and the
// chrome read those three records and nothing else.
const sessionWire = resolveSessionWire();
const projectSessions = createSessionSurfaces({
  storage: rendererState,
  post: sessionWire.post,
});
sessionWire.onMessage(projectSessions.receive);
let shellRenderQueued = false;
function scheduleShellRender(): void {
  if (shellRenderQueued) return;
  shellRenderQueued = true;
  queueMicrotask(() => {
    if (shellRenderQueued) rerenderShell();
  });
}
projectSessions.onChange(scheduleShellRender);
// A project whose session has not framed its host snapshot yet is not listed:
// the rail shows what is known.
const railProjects = (): RailProject[] =>
  shell.open.flatMap((key) => {
    const session = projectSessions.get(key);
    const canonicalDisplay = session?.host$.get()?.project;
    if (!session || !canonicalDisplay) return [];
    const projectName = projectWorkbenches.get(key)?.getState().projectName;
    const display = projectName
      ? { ...canonicalDisplay, name: projectName }
      : canonicalDisplay;
    const view = session.view$.get();
    return [{ display, view, surface: session.surface$.get() }];
  });
const activeRailProject = (projects: readonly RailProject[]) =>
  projects.find((project) => project.display.key === shell.active);
let renamingProjectKey: string | null = null;

function finishProjectRename(key: string, name: string | null): void {
  if (renamingProjectKey !== key) return;
  renamingProjectKey = null;
  const project = projectWorkbenches.get(key);
  if (project && name?.trim())
    project.updateState({ ...project.getState(), projectName: name.trim() });
  rerenderShell();
}
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

const projectWorkbenches = new Map<
  string,
  ReturnType<typeof createProjectWorkbench>
>();
// The rail's actions and records, over every open project.
const projectRail = createProjectRail({
  shell: () => shell,
  projects: () => railProjects(),
  sessions: projectSessions,
  workbenches: projectWorkbenches,
});
// Seen only while the window has focus: a run finishing behind another app is
// news when the user comes back.
const markShownRunSeen = () => {
  const view = projectSessions.get(shell.active)?.view$.get();
  if (view && document.hasFocus())
    projectSessions.act(shell.active, { kind: 'seen', view });
};
projectSessions.onChange(markShownRunSeen);
window.addEventListener('focus', markShownRunSeen);
const selectProject = projectRail.selectProject;

function currentWorkbench() {
  const project = projectWorkbenches.get(shell.active);
  if (!project) throw new Error(`No workbench for project ${shell.active}.`);
  return project;
}

function shellState(): DesktopShellState {
  return (
    projectWorkbenches.get(shell.active)?.getState() ??
    initialDesktopShellState()
  );
}

function updateShell(next: DesktopShellState): void {
  currentWorkbench().updateState(next);
}

function layoutChanged(
  session: string,
  previous: DesktopShellState,
  next: DesktopShellState,
): void {
  if (session !== shell.active || applyingProjectList) return;
  rerenderShell();
  currentWorkbench().workbench.syncBrowserViewBounds();
  const changedPlacements = WORKBENCH_PLACEMENTS.filter(
    (placement) =>
      previous.activeWorkbenchTabIds[placement] !==
      next.activeWorkbenchTabIds[placement],
  );
  const activeTabChanged = changedPlacements.length > 0;
  if (
    activeTabChanged ||
    previous.bottomPanelHeight !== next.bottomPanelHeight ||
    previous.sidebarWidth !== next.sidebarWidth ||
    previous.explorerWidth !== next.explorerWidth ||
    previous.workbenchWidth !== next.workbenchWidth ||
    previous.focusWorkspace !== next.focusWorkspace
  ) {
    currentWorkbench().workbench.layoutVisibleSurfaces({
      focus: activeTabChanged,
      activate: changedPlacements,
    });
  }
}

function toggleBottomBarVisibility(): void {
  currentWorkbench().workbench.togglePlacementVisibility('bottom', 'terminal');
}

function toggleSidePanelVisibility(): void {
  currentWorkbench().workbench.togglePlacementVisibility('right', 'files');
}

// `<progress-app>` is instantiated once and slotted into
// the shell template via Lit's DOM-node interpolation, so Lit preserves their
// internal state across re-renders and tab switches.
const noWorkspacePlaceholder: HTMLElement = document.createElement('section');
{
  // No project open: nothing can run yet, so say what TeXRA is and open one.
  noWorkspacePlaceholder.className = 'desktop-empty-workspace';
  render(
    html`
      <section class="desktop-empty-workspace-panel">
        <div class="shell-empty-icon icon-surface is-size-l">
          ${waIcon('folder-open')}
        </div>
        <h1>Open a project to start</h1>
        <p>${TEXRA_TAGLINE}</p>
        <ul class="desktop-empty-workspace-capabilities">
          <li>
            It reads your paper or code and does the work: derivations, proofs,
            literature, edits.
          </li>
          <li>
            By default it asks before it acts: edits arrive as diffs you accept
            or reject.
          </li>
          <li>You choose the model and the team; progress stays in view.</li>
        </ul>
        <div class="desktop-empty-workspace-actions">
          ${renderLabeledActionButton({
            icon: 'folder-open',
            text: 'Open project folder',
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
// launcher, its conversation branch the selected run. `rerenderShell`
// hands it the active project's session.
const conversationView = document.createElement('progress-app') as ProgressApp;
conversationView.placement = 'desktop';
// The attribute is what the element's desktop styles select on.
conversationView.setAttribute('placement', 'desktop');
conversationView.setAttribute('data-desktop-view', 'progress');

// Both hooks re-sync the browser view, which stays hidden while the dialog
// is open (`isBrowserCovered`).
const syncActiveBrowserView = () =>
  projectWorkbenches.get(shell.active)?.workbench.syncBrowserViewBounds();
const nativeViewOverlays = trackNativeViewOverlays(syncActiveBrowserView);
const settingsDialog = createDesktopSettingsDialog(appRoot, {
  onShown: syncActiveBrowserView,
  onHidden: syncActiveBrowserView,
});

// The logs viewer is hosted directly in its workbench tab body.
const logsController = createLogsPane();
const logsPane = logsController.element;

const promptOverlay = createDesktopPromptOverlay(appRoot, (message) =>
  hostBridge.postMessage(message),
);
applyTheme();

function shellWorkspaceToolbarTemplate(): TemplateResult {
  const projects = railProjects();
  const activeProject = activeRailProject(projects);
  // The sidebar is the only home for the rail's per-run pending-approval
  // badge (RunTabs.ts). Collapsing it removes that cue entirely, so a
  // call held at the approval gate — often on a workflow's child run, not
  // the one on screen, or in a project not shown — can stall with zero
  // visible affordance (#11511). Surface the same signal on the toggle that
  // reopens the rail.
  const hasPendingApproval = projects.some(
    (project) => project.view.rollup.waiting > 0,
  );
  const sidebarCollapsedWithPendingApproval =
    shellState().sidebarCollapsed && hasPendingApproval;
  let sidebarToggleLabel = shellState().sidebarCollapsed
    ? 'Show sidebar'
    : 'Hide sidebar';
  if (sidebarCollapsedWithPendingApproval) {
    sidebarToggleLabel = 'Show sidebar (approval pending)';
  }
  const sidebarToggle = html`<span class="shell-header-button-slot">
    ${renderIconActionButton({
      id: 'shellSidebarToggle',
      icon: 'table-columns',
      label: sidebarToggleLabel,
      tooltip: sidebarToggleLabel,
      className: 'shell-header-button icon-button',
      size: 's',
      onClick: () => updateShell(toggleSidebar(shellState())),
    })}
    ${
      sidebarCollapsedWithPendingApproval
        ? html`<span
            class="status-dot shell-header-pending-approval-badge"
            aria-hidden="true"
          ></span>`
        : nothing
    }
  </span>`;
  const workspace = shellState().focusWorkspace;
  function showWorkspace(): void {
    if (!activeWorkbenchTab(shellState(), 'right'))
      currentWorkbench().workbench.openKind('files');
    else updateShell({ ...shellState(), focusWorkspace: true });
  }
  return html`
    <header class="shell-workspace-toolbar">
      <span class="shell-wordmark">TeXRA</span>
      ${sidebarToggle}
      <span class="shell-workspace-project"
        >${activeProject?.display.name ?? 'Research workspace'}</span
      >
      <nav class="shell-view-switch" aria-label="Main view">
        ${renderLabeledActionButton({
          id: 'shellTaskView',
          text: 'Tasks',
          icon: 'comment',
          kind: 'ghost',
          pressed: !workspace,
          onClick: () =>
            updateShell({ ...shellState(), focusWorkspace: false }),
        })}
        ${renderLabeledActionButton({
          id: 'shellWorkspaceView',
          text: 'Workspace',
          icon: 'table-columns',
          kind: 'ghost',
          pressed: workspace,
          disabled: !hasWorkspace(),
          onClick: showWorkspace,
        })}
      </nav>
      <div class="shell-workspace-tools">
        ${renderLabeledActionButton({
          id: 'shellToggleSidePanel',
          icon: 'folder-tree',
          text: 'Files',
          kind: 'ghost',
          className: 'is-compact',
          disabled: !hasWorkspace(),
          onClick: () => currentWorkbench().workbench.openKind('files'),
        })}
        ${renderLabeledActionButton({
          id: 'shellToggleTerminalPanel',
          icon: 'terminal',
          text: 'Terminal',
          kind: 'ghost',
          className: 'is-compact',
          pressed:
            workspace && activeWorkbenchTab(shellState(), 'bottom') != null,
          disabled: !hasWorkspace(),
          onClick: () => {
            if (!workspace) {
              if (activeWorkbenchTab(shellState(), 'bottom'))
                updateShell({ ...shellState(), focusWorkspace: true });
              else currentWorkbench().workbench.openKind('terminal');
            } else toggleBottomBarVisibility();
          },
        })}
      </div>
    </header>
  `;
}

function shellConversationTemplate(): TemplateResult {
  const activeProject = activeRailProject(railProjects());
  render(nothing, conversationView);
  return html`
    <main class="shell-conversation" aria-label="Task conversation">
      <div class="shell-conversation-body" id="desktop-center">
        <section class="shell-conversation-pane" data-pane="conversation">
          ${
            hasWorkspace()
              ? html`
                  <section
                    class="shell-launcher-surface"
                    data-session=${activeProject ? activeProject.display.key : nothing}
                  >
                    ${conversationView}
                  </section>
                `
              : noWorkspacePlaceholder
          }
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
 * Store the split handle's measured size on this project's surface.
 */
function recordLayoutMeasurement(next: DesktopShellState): void {
  if (applyingProjectList) return;
  projectWorkbenches.get(shell.active)?.updateState(next);
}

/**
 * Read the split handle's measured size from a `wa-reposition` event.
 *
 * A panel that has not been laid out yet has `size === 0`, so the component's
 * pixels↔percent conversion produces NaN/Infinity and the first reposition
 * event can carry a non-finite `positionInPixels`. Skip that emission; the
 * panel's resize observer re-fires with the real measurement after layout.
 */
function measuredSplitPosition(event: Event): number | undefined {
  const value = (event.currentTarget as SplitPanelElement).positionInPixels;
  return Number.isFinite(value) ? value : undefined;
}

function rememberSidebarWidth(event: Event): void {
  if (shellState().sidebarCollapsed) return;
  const width = measuredSplitPosition(event);
  if (width == null) return;
  recordLayoutMeasurement(setSidebarWidth(shellState(), width));
}

function rememberBottomPanelHeight(event: Event): void {
  if (!activeWorkbenchTab(shellState(), 'bottom')) return;
  const height = measuredSplitPosition(event);
  if (height == null) return;
  recordLayoutMeasurement(setBottomPanelHeight(shellState(), height));
}

function projectWorkbenchesTemplate(
  placement: WorkbenchPlacement,
): TemplateResult {
  return html`${repeat(
    projectWorkbenches.values(),
    (project) => project.session,
    (project) =>
      html` <div
        class="shell-project-workbench"
        data-session=${project.session}
        ?hidden=${project.session !== shell.active || !activeWorkbenchTab(project.getState(), placement)}
      >
        ${project.workbench.template(placement)}
      </div>`,
  )} `;
}

/**
 * A closed pane's split: no divider, and no minimum. The split panel clamps
 * its position to `--min`, so a closed pane left at its minimum kept an
 * empty strip of that size beside the conversation.
 */
const CLOSED_SPLIT_STYLE = '--divider-width: 0px; --min: 0px';

function shellMainTemplate(
  rightTab: WorkbenchTab | undefined,
  bottomTab: WorkbenchTab | undefined,
): TemplateResult {
  const workspace = shellState().focusWorkspace;
  return html` <div class="shell-view-stack">
    <section class="shell-task-view" ?hidden=${workspace}>
      ${shellConversationTemplate()}
    </section>
    <section
      class="shell-workspace-view"
      ?hidden=${!workspace}
      aria-label="Workspace"
    >
      <wa-split-panel
        class="shell-bottom-split"
        orientation="vertical"
        primary="end"
        position-in-pixels=${bottomTab ? shellState().bottomPanelHeight : 0}
        ?disabled=${!bottomTab}
        style=${bottomTab ? nothing : CLOSED_SPLIT_STYLE}
        @wa-reposition=${rememberBottomPanelHeight}
      >
        <div slot="start" class="shell-workbench-panel">
          ${projectWorkbenchesTemplate('right')}
          ${
            rightTab
              ? nothing
              : html`<div class="shell-workspace-empty">
                  <h2>Your workspace</h2>
                  <p>Open Files to browse this project's documents and code.</p>
                </div>`
          }
        </div>
        <div slot="end" class="shell-bottom-workbench-panel">
          ${projectWorkbenchesTemplate('bottom')}
        </div>
      </wa-split-panel>
    </section>
  </div>`;
}

function shellTemplate(): TemplateResult {
  const rightTab = activeWorkbenchTab(shellState(), 'right');
  const bottomTab = activeWorkbenchTab(shellState(), 'bottom');
  const main = shellMainTemplate(rightTab, bottomTab);
  const workbenchOpen = rightTab != null || bottomTab != null;

  return html`
    <div class="desktop-app">
      ${shellWorkspaceToolbarTemplate()}
      <wa-split-panel
        class="shell-frame ${shellState().sidebarCollapsed ? 'shell-frame-collapsed' : ''}"
        orientation="horizontal"
        primary="start"
        position-in-pixels=${shellState().sidebarCollapsed ? 0 : shellState().sidebarWidth}
        ?disabled=${shellState().sidebarCollapsed}
        style=${shellState().sidebarCollapsed ? CLOSED_SPLIT_STYLE : nothing}
        data-workbench-open=${String(workbenchOpen)}
        data-right-panel-open=${String(rightTab != null)}
        data-bottom-panel-open=${String(bottomTab != null)}
        @wa-reposition=${rememberSidebarWidth}
      >
        <div
          slot="start"
          class="shell-sidebar-slot"
          ?hidden=${shellState().sidebarCollapsed}
        >
          ${shellSidebarTemplate(
            {
              projects: railProjects(),
              renamingProjectKey,
              shell,
              commandsLabel: commandLabel(DESKTOP_COMMAND_PALETTE_ID),
              commandsTitle: commandTitle(DESKTOP_COMMAND_PALETTE_ID),
            },
            {
              onNewTask: returnToLauncher,
              onOpenCommands: () => palette.open(),
              onOpenFolder: () =>
                postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
              onSelectProject: selectProject,
              onProjectAction: (key, action) => {
                if (action !== 'rename')
                  return projectRail.runProjectAction(key, action);
                renamingProjectKey = key;
                rerenderShell();
                requestAnimationFrame(() => {
                  const input = appRoot.querySelector<HTMLInputElement>(
                    '.shell-project-rename',
                  );
                  input?.focus();
                  input?.select();
                });
              },
              onRenameProject: finishProjectRename,
              onOpenSettings: () => settingsDialog.open(),
            },
          )}
        </div>
        <div slot="end" class="shell-frame-main-panel">
          <div class="shell-workspace-layout">${main}</div>
        </div>
      </wa-split-panel>
    </div>
  `;
}

let surfaceResizeObserver: ResizeObserver | undefined;
let surfaceLayoutFrame: number | undefined;
const observedSurfaces = new Set<Element>();

function observeSurfaceResizes(): void {
  surfaceResizeObserver ??= new ResizeObserver(() => {
    if (surfaceLayoutFrame !== undefined) return;
    // Monaco/xterm mutate layout. Run outside ResizeObserver delivery so those
    // writes cannot feed back into the observer loop in the same frame.
    surfaceLayoutFrame = requestAnimationFrame(() => {
      surfaceLayoutFrame = undefined;
      const project = projectWorkbenches.get(shell.active);
      if (!project || applyingProjectList) return;
      project.workbench.layoutVisibleSurfaces({ activate: [] });
      project.workbench.syncBrowserViewBounds();
    });
  });
  const surfaces = new Set(
    document.querySelectorAll(
      '.shell-conversation, .shell-project-workbench:not([hidden]) .shell-workbench',
    ),
  );
  for (const element of observedSurfaces) {
    if (surfaces.has(element)) continue;
    surfaceResizeObserver.unobserve(element);
    observedSurfaces.delete(element);
  }
  for (const element of surfaces) {
    if (observedSurfaces.has(element)) continue;
    surfaceResizeObserver.observe(element);
    observedSurfaces.add(element);
  }
}

function rerenderShell(): void {
  shellRenderQueued = false;
  if (applyingProjectList) return;
  projectRail.revealSidebarForOffScreenRequest();
  const active = activeRailProject(railProjects());
  const session = active ? projectSessions.get(active.display.key) : undefined;
  conversationView.view = active?.view ?? null;
  conversationView.surface = active?.surface ?? null;
  conversationView.host = session?.host$.get() ?? null;
  render(
    projectWorkbenches.has(shell.active)
      ? shellTemplate()
      : noWorkspacePlaceholder,
    appRoot,
  );
  logsController.setActive(
    activeWorkbenchTab(shellState(), 'right')?.kind === 'logs' ||
      activeWorkbenchTab(shellState(), 'bottom')?.kind === 'logs',
  );
  if (projectWorkbenches.has(shell.active)) observeSurfaceResizes();
}

function reportRuntimeFailure(error: unknown): void {
  console.error('TeXRA desktop renderer failure', error);
  const shouldReload = window.confirm(
    `TeXRA encountered an unexpected error.\n\n${extractErrorMessage(error) ?? 'TeXRA could not finish starting up.'}\n\nReload TeXRA now?`,
  );
  if (shouldReload) window.location.reload();
}

// =============================================================================
// Bootstrap
// =============================================================================

// A failed first render or a rejected promise is reported once, loudly, with
// the choice to reload; nothing renders a second copy of the shell.
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  reportRuntimeFailure(event.reason);
});

try {
  logsController.rerenderViewer();
  rerenderShell();
} catch (error) {
  reportRuntimeFailure(error);
}

// =============================================================================
// Onboarding + command palette
// =============================================================================

const desktopRendererCommandActions: DesktopCommandActions = {
  showLauncher: returnToLauncher,
  openWorkbench: (kind) => currentWorkbench().workbench.openKind(kind),
  showSettings: settingsDialog.open,
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
  toggleBottomBar: toggleBottomBarVisibility,
  toggleSidePanel: toggleSidePanelVisibility,
};
const shortcuts = createDesktopShortcutRegistry({
  document,
  actions: desktopRendererCommandActions,
  openCommands: () => palette.open(),
});
const palette = createDesktopCommandPalette({
  document,
  actions: desktopRendererCommandActions,
  getShortcuts: () => shortcuts.entries(),
});
document.body.append(palette.element);
shortcuts.subscribe((entries) => {
  shortcutAcceleratorsById.clear();
  for (const entry of entries) {
    shortcutAcceleratorsById.set(entry.id, entry.accelerator);
  }
  rerenderShell();
});

// Clear the active run so the conversation shell shows its empty state.
function returnToLauncher(): void {
  if (shellState().focusWorkspace)
    updateShell({ ...shellState(), focusWorkspace: false });
  projectSessions.act(shell.active, { kind: 'selectNew' });
}

const LAYOUT_PANEL_TOGGLES: Record<DesktopLayoutPanel, () => void> = {
  bottomBar: toggleBottomBarVisibility,
  sidePanel: toggleSidePanelVisibility,
};

const routeMessage = createMessageRoutes({
  'desktop:saveFile': () => {
    void projectWorkbenches.get(shell.active)?.editorPane.save();
  },
  // `refresh()` re-lists from the root and drops the expansion state, which is
  // the same reset the Files rail already performs each time it is opened —
  // so this stays consistent with how the pane behaves everywhere else rather
  // than introducing a second, subtler kind of refresh.
  'desktop:workspace:filesChanged': (message) => {
    void projectWorkbenches.get(message.session)?.editorPane.refresh();
  },
  'desktop:openWorkbench': (message) =>
    projectWorkbenches.get(shell.active)?.workbench.openKind(message.kind),
  'desktop:openSettings': () => settingsDialog.open(),
  'desktop:toggleLayout': (message) => {
    if (projectWorkbenches.has(shell.active)) {
      LAYOUT_PANEL_TOGGLES[message.panel]();
    }
  },
  'desktop:setLog': (message) => logsController.applySnapshot(message),
  'desktop:showDiff': (message) => {
    const project = projectWorkbenches.get(message.session);
    project?.reviewPane.open(message);
    project?.workbench.openKind('review');
  },
  'desktop:closeDiff': (message) => {
    // A close takes its own diff off the pane and nothing else; the Review
    // tab goes only once that leaves the pane empty, so a request settling
    // never dismisses another request's preview or an unrelated review.
    const project = projectWorkbenches.get(message.session);
    if (project?.reviewPane.close(message.previewId)) {
      project.workbench.disposeWorkbenchTab('workbench:review');
    }
  },
  'desktop:showPdf': (message) => {
    const project = projectWorkbenches.get(message.session);
    if (!project) return;
    project.updateState(
      openWorkbenchTab(project.getState(), {
        kind: 'pdf',
        target: message.pdfUrl,
        title: message.title,
      }),
    );
  },
  'desktop:showPrompt': (message) => promptOverlay.open(message),
  'desktop:terminal:data': (message) =>
    projectWorkbenches
      .get(message.session)
      ?.terminalPane.write(message.sessionId, message.data),
  'desktop:terminal:exit': (message) =>
    projectWorkbenches
      .get(message.session)
      ?.terminalPane.reportExit(message.sessionId, message.exitCode),
  'desktop:terminal:error': (message) =>
    projectWorkbenches
      .get(message.session)
      ?.terminalPane.reportError(message.sessionId, message.message),
  'desktop:terminal:openCommand': (message) =>
    projectWorkbenches
      .get(message.session)
      ?.workbench.openTerminalCommand(message.initialCommand),
  // Renames the document so a browser tab reads as its page rather than a
  // generic "Browser".
  'desktop:browser:state': (message) => {
    const project = projectWorkbenches.get(message.session);
    if (project) {
      project.updateState(
        renameWorkbenchTab(project.getState(), message.tabId, message.title),
      );
    }
  },
  'desktop:projects': (message) => {
    const previousKey = shell.active;
    // The list changes resource ownership and selection together. Keep signal
    // notifications from painting an intermediate owner during this adoption.
    applyingProjectList = true;
    try {
      projectsKnown = true;
      const { open } = message;
      const sessions = [...new Set([...open, message.activeKey])];
      for (const [key, project] of projectWorkbenches) {
        if (sessions.includes(key)) continue;
        project.dispose();
        projectWorkbenches.delete(key);
      }
      projectSessions.sync(sessions);
      for (const key of sessions) {
        if (projectWorkbenches.has(key)) continue;
        const project = createProjectWorkbench({
          session: key,
          surfaces: projectSessions,
          logsPane,
          isActive: () => shell.active === key,
          isBrowserCovered: () =>
            settingsDialog.isOpen() || nativeViewOverlays.isCovered(),
          onLayoutChanged: layoutChanged,
        });
        projectWorkbenches.set(key, project);
        project.setTheme(currentTheme());
        if (open.includes(key)) void project.editorPane.refresh();
      }
      setShell({
        ...shell,
        active: message.activeKey,
        open,
        collapsed: shell.collapsed.filter((key) => open.includes(key)),
      });
    } finally {
      applyingProjectList = false;
    }
    rerenderShell();
    if (previousKey !== message.activeKey) {
      settingsDialog.remount();
      currentWorkbench().workbench.layoutVisibleSurfaces({ focus: false });
      currentWorkbench().workbench.syncBrowserViewBounds();
    }
  },
});

// The shell's one message listener, for the desktop commands. The session
// protocol has its own channel (`sessionWire`, above). The settings view's
// pushes reach `<settings-app>` through its own listener and match no route
// here.
window.addEventListener('message', (event) => routeMessage(event.data));

// Keep the embedded browser aligned when the window resizes: its view is
// positioned in absolute window coordinates, not renderer layout.
window.addEventListener('resize', () => {
  const project = projectWorkbenches.get(shell.active);
  if (!project || applyingProjectList) return;
  project.workbench.syncBrowserViewBounds();
  project.editorPane.layout();
  project.terminalPane.layout();
});

// =============================================================================
// Shell events: the identity translation of PRD 8
// =============================================================================
//
// Every component dispatches the arm it wants as a bubbling, composed event
// (`uiEvents.ts`); the root forwards it to the project it came from. The project
// is the nearest `data-session` on the event's path: the conversation column
// (the shell and its dock) carries the shown project's key, and each project's
// workbench and rail tree its own.

function sessionOf(event: Event): string | undefined {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLElement && node.dataset.session) {
      return node.dataset.session;
    }
  }
  return undefined;
}

appRoot.addEventListener('runtime-request', (event) => {
  const key = sessionOf(event);
  if (key) projectSessions.runtimeRequest(key, event.detail);
});
appRoot.addEventListener('host-request', (event) => {
  const key = sessionOf(event);
  if (key) projectSessions.hostRequest(key, event.detail);
});
appRoot.addEventListener('surface-action', (event) => {
  const key = sessionOf(event);
  if (!key) return;
  if (event.detail.kind === 'select' || event.detail.kind === 'selectNew') {
    const project = projectWorkbenches.get(key);
    const state = project?.getState();
    if (state?.focusWorkspace)
      project?.updateState({ ...state, focusWorkspace: false });
  }
  projectSessions.act(key, event.detail);
  // The rail is bound to one active run across every section: picking
  // a run in another project's tree picks that project too (PRD 12.2).
  if (event.detail.kind === 'select' && key !== shell.active) {
    selectProject(key);
  }
});
appRoot.addEventListener('composer-submit', (event) => {
  const key = sessionOf(event);
  if (key) projectSessions.submit(key);
});

// The projects list arrives in reply; each project's session subscribes as it
// opens, and the file tree refreshes when the list names the project this
// window shows.
postMessage(DESKTOP_PROJECT_COMMANDS.REQUEST_PROJECTS);
document.body.dataset.desktopReady = 'true';

// Sole owner of "the workspace has unsaved editor changes": the main process
// keeps no copy and learns of it only when this veto raises will-prevent-unload.
window.addEventListener('beforeunload', (event) => {
  const dirty = [...projectWorkbenches.values()].some((project) =>
    project.editorPane.hasUnsavedChanges(),
  );
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener(
  'unload',
  () => {
    surfaceResizeObserver?.disconnect();
    if (surfaceLayoutFrame !== undefined)
      cancelAnimationFrame(surfaceLayoutFrame);
    shortcuts.dispose();
    for (const project of projectWorkbenches.values()) project.dispose();
    projectWorkbenches.clear();
    projectSessions.dispose();
  },
  { once: true },
);
