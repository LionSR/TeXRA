import './styles.css';
import './themeTokens.css';

import '@shared/wa';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, render, type TemplateResult } from 'lit';
import { create as mutate } from 'mutative';
import '@progressView/frontend';
import '@progressView/frontend/components/TexraDiffView';
import type { StreamTabs } from '@progressView/frontend/components/StreamTabs';
import {
  handleDeleteAll,
  handleFileAction,
  handleFilterChange,
  handleFollowupRequestOptions,
  handleFollowUpChange,
  handleFollowUpClear,
  handleFollowUpFocusComplete,
  handleFollowUpPolish,
  handleFollowUpSend,
  handleGettingStartedAction,
  handlePermissionAction,
  handleStreamDelete,
  handleStreamSwitch,
  handleToolbarCommand,
  runCompileFixer,
  sendFollowupCommand,
} from '@progressView/frontend/eventHandlers';
import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
import {
  activeStreamId$,
  appState,
  childStreamsByParent$,
  hasAnyStreams$,
  pendingApprovalIds$,
  streamFilter$,
  streamStates$,
  streams$,
  tabStreams$,
} from '@progressView/frontend/progressState';
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import '@settingsView/frontend';
import '@webview/frontend';
import { hostBridge, postMessage } from '@shared/hostBridge';
import type { StreamTabId } from '@shared/schemas';
import { Signal } from '@shared/signals';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';
import { formatDesktopAccelerator } from '@shared/commands/accelerators';
import {
  SetThemeMessageSchema,
  type DesktopThemeKind,
} from '@shared/schemas/commonViewMessages';
import {
  ProgressViewOutboundMessageSchema,
  type ProgressViewOutboundMessage,
} from '@shared/schemas/progressView';
import {
  applyHostBodyTheme,
  getWindowTargetOrigin,
} from '@shared/wa/hostTheme';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@shared/wa/actionButtons';
import { waIcon, type TeXRAIconName } from '@shared/wa/webAwesomeIcons';

import {
  DesktopSetRouteMessageSchema,
  type DesktopRoute,
} from '../desktopShellMessages';
import { DesktopSetLogMessageSchema } from '../desktopLogMessages';
import {
  buildDesktopMainViewResetMessage,
  buildDesktopSettingsTabMessage,
  DESKTOP_LOCAL_COMMANDS,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandId,
} from '../desktopCommandSurface';
import {
  DESKTOP_ONBOARDING_COMMANDS,
  DesktopOnboardingSetStateMessageSchema,
} from '../desktopOnboardingMessages';
import {
  DesktopShowDiffMessageSchema,
  DesktopCloseDiffMessageSchema,
} from '../desktopDiffMessages';
import {
  DesktopShowPdfMessageSchema,
  DesktopClosePdfMessageSchema,
} from '../desktopPdfMessages';
import { DesktopShowPromptMessageSchema } from '../desktopPromptMessages';
import { createDesktopCommandPalette } from './desktopCommandPalette';
import { createFirstRunWalkthrough } from './desktopOnboarding';
import { tabStripTemplate } from './tabStrip';
import { createEditorPane, type EditorFileEntry } from './editorPane';
import { createTerminalPane } from './terminalPane';
import {
  activateTab,
  activeTab,
  closeTab,
  initialTabState,
  openTab,
  setTabDirty,
  tabIdFor,
  tabKindForRoute,
  type DesktopTabKind,
  type DesktopTabState,
} from '../desktopWorkspaceTabs';
import {
  DESKTOP_WORKSPACE_COMMANDS,
  DesktopBrowserStateMessageSchema,
  DesktopFileErrorMessageSchema,
  DesktopFileReadMessageSchema,
  DesktopFilesListedMessageSchema,
  DesktopFileWrittenMessageSchema,
  DesktopTerminalDataMessageSchema,
  DesktopTerminalErrorMessageSchema,
  DesktopTerminalExitMessageSchema,
} from '../desktopWorkspaceMessages';
import { getRendererPlatform } from './rendererPlatform';
import { createPdfOverlay } from './pdfOverlay';
import { createDiffOverlay } from './diffOverlay';
import { createDesktopPromptOverlay } from './promptOverlay';
import { createLogsPane } from './logsPane';

const root = document.querySelector<HTMLElement>('#app');

if (root == null) {
  throw new Error('TeXRA desktop renderer root was not found.');
}

const appRoot = root;

// =============================================================================
// Pane state
// =============================================================================
//
// The window is a tab shell. The workspace tab holds the two-pane layout:
//   - Left rail: <stream-tabs> (sessions)
//   - Center: <main-app> when no active stream, else <stream-conversation>
// Settings, Logs, editors, terminals, and browser tabs are siblings of it.
//
// `setRouteState` survives only as a backwards-compat hook so existing IPC
// (`desktop:setRoute` from menu/command-palette) still reaches the right
// surface; tabKindForRoute maps each legacy route onto its owning tab.

const hasWorkspace = window.texraDesktop?.hasWorkspace ?? true;
const rendererPlatform = getRendererPlatform(document.defaultView);
const desktopCommandEntriesById = new Map(
  getDesktopCommandMenuEntries(undefined, rendererPlatform).map((entry) => [
    entry.id,
    entry,
  ]),
);

function shortcutTitle(label: string, accelerator: string | undefined): string {
  const shortcut = formatDesktopAccelerator(accelerator, rendererPlatform);
  return shortcut ? `${label} - ${shortcut}` : label;
}

function commandTitle(commandId: DesktopCommandId, label: string): string {
  return shortcutTitle(
    label,
    desktopCommandEntriesById.get(commandId)?.accelerator,
  );
}

function setRouteState(route: DesktopRoute): void {
  document.body.dataset.desktopRoute = route;
}

// =============================================================================
// Tab state
// =============================================================================
//
// Settings and Logs used to be modal overlays, which meant reading either one
// covered the run you were configuring. They are now tabs alongside the
// workspace, so state is inspectable while a run streams.
//
// The tab reducer lives in ../desktopWorkspaceTabs.ts (pure, unit-tested); this
// module owns only the mutable current value and the re-render trigger.

let tabState: DesktopTabState = initialTabState();

function updateTabs(next: DesktopTabState): void {
  if (next === tabState) return;
  const previousTabId = tabState.activeTabId;
  tabState = next;
  rerenderShell();
  syncBrowserViewBounds();
  // Lay out only on an actual tab change; a dirty-flag or title update
  // re-renders the strip but must not re-open the editor's file.
  if (previousTabId !== next.activeTabId) layoutActivePane();
}

function openWorkspaceTab(kind: DesktopTabKind, target?: string): void {
  updateTabs(openTab(tabState, { kind, ...(target ? { target } : {}) }));
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
  render(emptyWorkspaceTemplate(), noWorkspacePlaceholder);
}

const conversationView: HTMLElement = document.createElement(
  'stream-conversation',
);
conversationView.setAttribute('data-desktop-view', 'progress');

// Left rail: a fresh <stream-tabs> mount wired to module-level progressState.
// PRD § 7.D requires mounting <stream-tabs> directly (not inside <progress-app>).
const railTabs = document.createElement('stream-tabs') as StreamTabs;

const settingsView: HTMLElement = document.createElement('settings-app');
settingsView.setAttribute('data-desktop-view', 'settings');

// The logs viewer now lives in a tab instead of a drawer, so its element is
// hosted directly in the tab body rather than inside a wa-drawer.
const logsController = createLogsPane();
const logsPane = logsController.element;

// Editor + terminal panes. Both are created eagerly but load their heavy
// dependencies (Monaco, xterm) lazily on first activation, so an app that never
// opens either pays nothing.
const editorPane = createEditorPane({
  listFiles: () => requestFiles(),
  readFile: (path) => requestFileRead(path),
  writeFile: (path, contents) => requestFileWrite(path, contents),
  onDirtyChange: (path, dirty) => {
    updateTabs(
      setTabDirty(tabState, tabIdFor({ kind: 'editor', target: path }), dirty),
    );
  },
  onError: (error) => console.error('TeXRA editor pane', error),
});

const terminalPane = createTerminalPane({
  start: (sessionId, cols, rows) =>
    postMessage(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START, {
      sessionId,
      cols,
      rows,
    }),
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

const diffOverlay = createDiffOverlay(appRoot);
const pdfOverlay = createPdfOverlay(appRoot);
const promptOverlay = createDesktopPromptOverlay(appRoot, (message) =>
  hostBridge.postMessage(message),
);

function openLogsDrawer(): void {
  openWorkspaceTab('logs');
  logsController.open();
}

// =============================================================================
// Editor / terminal / browser request plumbing
// =============================================================================
//
// The renderer is sandboxed, so file I/O runs in the main process. These
// helpers turn the fire-and-forget message pairs into promises the editor pane
// can await, keyed by path so concurrent reads don't cross-resolve.

type PendingFileRequest = {
  resolve(contents: string): void;
  reject(error: Error): void;
};

const pendingFileReads = new Map<string, PendingFileRequest[]>();
const pendingFileWrites = new Map<string, PendingFileRequest[]>();
let pendingFileList:
  | {
      resolve(files: readonly EditorFileEntry[]): void;
      reject(error: Error): void;
    }
  | undefined;

function settlePending(
  map: Map<string, PendingFileRequest[]>,
  path: string,
  settle: (request: PendingFileRequest) => void,
): void {
  const waiting = map.get(path);
  if (!waiting) return;
  map.delete(path);
  for (const request of waiting) settle(request);
}

function requestFiles(): Promise<readonly EditorFileEntry[]> {
  return new Promise((resolve, reject) => {
    pendingFileList = { resolve, reject };
    postMessage(DESKTOP_WORKSPACE_COMMANDS.LIST_FILES);
  });
}

function requestFileRead(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const waiting = pendingFileReads.get(path) ?? [];
    waiting.push({ resolve, reject });
    pendingFileReads.set(path, waiting);
    postMessage(DESKTOP_WORKSPACE_COMMANDS.READ_FILE, { path });
  });
}

function requestFileWrite(path: string, contents: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const waiting = pendingFileWrites.get(path) ?? [];
    waiting.push({ resolve: () => resolve(), reject });
    pendingFileWrites.set(path, waiting);
    postMessage(DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE, { path, contents });
  });
}

/**
 * Reports the browser slot's geometry to the main process, which positions the
 * WebContentsView over it. A WebContentsView is not part of renderer layout, so
 * this runs on every render, resize, and tab switch — otherwise the view would
 * float where the slot used to be.
 */
function syncBrowserViewBounds(): void {
  const current = activeTab(tabState);
  if (current.kind !== 'browser') {
    postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE);
    return;
  }
  // Measure after layout settles; a tab that just became visible has no box
  // until the browser has flushed the style change.
  requestAnimationFrame(() => {
    const slot = document.querySelector('#desktop-browser-slot');
    if (!slot) return;
    const rect = slot.getBoundingClientRect();
    postMessage(DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS, {
      tabId: current.id,
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
 * Lays out whichever pane just became active. Monaco and xterm both measure
 * their container on demand and render at zero size if that happened while the
 * container was `display:none`.
 */
function layoutActivePane(): void {
  const current = activeTab(tabState);
  if (current.kind === 'editor') {
    editorPane.layout();
    if (current.target) void editorPane.open(current.target);
    return;
  }
  if (current.kind === 'terminal') {
    terminalPane.activate(current.id);
  }
}

const NEW_TAB_ENTRIES: ReadonlyArray<{
  readonly label: string;
  readonly icon: TeXRAIconName;
  readonly run: () => void;
}> = [
  {
    label: 'Editor',
    icon: 'file-code',
    run: () => {
      openWorkspaceTab('editor');
      void editorPane.refresh();
    },
  },
  {
    label: 'Terminal',
    icon: 'terminal',
    run: () => openWorkspaceTab('terminal'),
  },
  {
    label: 'Browser',
    icon: 'globe',
    run: () => openWorkspaceTab('browser', 'https://texra.ai/'),
  },
  { label: 'Settings', icon: 'gear', run: () => openWorkspaceTab('settings') },
  { label: 'Logs', icon: 'file-lines', run: () => openWorkspaceTab('logs') },
];

/**
 * New-tab menu. A lightweight popover positioned under the "+" button rather
 * than a wa-dropdown: the trigger is re-created on every shell render, and
 * wa-dropdown binds to its trigger element identity.
 */
function openNewTabMenu(anchor: HTMLElement): void {
  const existing = document.querySelector('.desktop-new-tab-menu');
  if (existing) {
    existing.remove();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'desktop-new-tab-menu';
  menu.setAttribute('role', 'menu');
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.left = `${Math.round(rect.left)}px`;
  render(
    html`${NEW_TAB_ENTRIES.map(
      (entry) => html`
        <button
          type="button"
          role="menuitem"
          class="desktop-new-tab-item"
          @click=${() => {
            menu.remove();
            entry.run();
          }}
        >
          ${waIcon(entry.icon)} <span>${entry.label}</span>
        </button>
      `,
    )}`,
    menu,
  );
  appRoot.append(menu);
  // Dismiss on the next outside click. `capture` so it runs before the item's
  // own handler removes the menu, and `once` so it never leaks.
  setTimeout(() => {
    document.addEventListener(
      'click',
      (event) => {
        if (!menu.contains(event.target as Node)) menu.remove();
      },
      { once: true, capture: true },
    );
  }, 0);
}

function emptyWorkspaceTemplate(): TemplateResult {
  return html`
    <section class="desktop-empty-workspace-panel">
      <h1>Open a folder to use TeXRA</h1>
      <p>
        TeXRA desktop needs a workspace before it can discover files, run
        agents, and place outputs.
      </p>
      <ul class="desktop-empty-workspace-capabilities">
        <li>Select TeX, Markdown, or text files from the opened folder.</li>
        <li>Run workflow or tool-use agents with the chosen model.</li>
        <li>Review progress, logs, and generated outputs in one window.</li>
      </ul>
      <div class="desktop-empty-workspace-actions">
        ${renderLabeledActionButton({
          icon: 'folder-open',
          text: 'Open Folder',
          appearance: 'filled',
          variant: 'brand',
          className: 'desktop-primary-button',
          onClick: () =>
            postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
        })}
        ${renderLabeledActionButton({
          icon: 'file-lines',
          text: 'Logs',
          appearance: 'outlined',
          className: 'desktop-secondary-button',
          onClick: openLogsDrawer,
        })}
      </div>
    </section>
  `;
}

// =============================================================================
// Progress message + event wiring (without mounting <progress-app>)
// =============================================================================
//
// PRD § 7.C: `<progress-app>` is NOT mounted in Electron; the children mount
// directly. The same `messageDispatcher` + `eventHandlers` modules drive both
// hosts over the shared `progressState` singletons.
//
// Filter persistence isn't wired on desktop (yet) — that layer is VS
// Code-only, in `ProgressApp.onFilterChange`. Filter changes still apply for
// the active session.

function isProgressOutboundMessage(
  raw: unknown,
): raw is ProgressViewOutboundMessage {
  return ProgressViewOutboundMessageSchema.safeParse(raw).success;
}

// =============================================================================
// Shell template
// =============================================================================

function getWorkspaceDirectoryLabel(workspacePath: string | undefined): string {
  if (!workspacePath) return 'No folder';

  const normalized = workspacePath.replaceAll('\\', '/');
  const trimmed = normalized.replace(/\/+$/, '');
  if (!trimmed) return normalized.startsWith('/') ? '/' : workspacePath;
  return trimmed.split('/').at(-1) || trimmed;
}

function shellTemplate(): TemplateResult {
  const activeId = activeStreamId$.get();
  const hasStreams = hasAnyStreams$.get();
  const showConversation = activeId != null && hasStreams;
  const workspacePath = window.texraDesktop?.workspacePath;
  const workspaceDirectoryLabel = getWorkspaceDirectoryLabel(workspacePath);
  const current = activeTab(tabState);
  return html`
    <section class="desktop-shell">
      <nav class="desktop-nav" aria-label="Desktop chrome">
        <span class="desktop-workspace-directory" title=${workspacePath ?? ''}>
          ${waIcon('folder-open', { className: 'desktop-workspace-icon' })}
          ${workspaceDirectoryLabel}
        </span>
        ${renderIconActionButton({
          icon: 'arrow-left',
          label: 'Back to launcher',
          className: 'desktop-icon-button',
          appearance: 'plain',
          hidden: !(showConversation && current.kind === 'workspace'),
          title: commandTitle('texra.showMainView', 'Back to launcher'),
          onClick: returnToLauncher,
        })}
        <!--
          No icon in this design — renderLabeledActionButton requires one,
          so this command-palette trigger stays hand-rolled (aria-haspopup
          also isn't part of the shared helper's option surface).
        -->
        <wa-button
          class="desktop-command-button"
          appearance="outlined"
          size="small"
          aria-haspopup="dialog"
          title=${shortcutTitle('Commands', 'CommandOrControl+K')}
          @click=${openCommandPalette}
        >
          ${waIcon('search', { slot: 'start' })} Commands
        </wa-button>
      </nav>
      ${tabStripTemplate(tabState, {
        onActivate: (tabId) => updateTabs(activateTab(tabState, tabId)),
        onClose: (tabId) => updateTabs(closeTab(tabState, tabId)),
        onNew: openNewTabMenu,
      })}
      <div class="desktop-tab-body">
        <!--
          Every tab's pane stays mounted and is hidden when inactive, rather
          than being torn down and rebuilt on each switch. Monaco models,
          terminal scrollback, and in-flight <settings-app> edits all live in
          DOM state that a remount would silently discard.
        -->
        <section
          class="desktop-tab-pane"
          data-tab-pane="workspace"
          ?hidden=${current.kind !== 'workspace'}
        >
          <div class="desktop-two-pane">
            <aside class="desktop-rail" aria-label="Sessions">
              <header class="desktop-rail-header">
                <div class="desktop-rail-header-content">
                  <span class="desktop-rail-title">Sessions</span>
                </div>
                ${renderIconActionButton({
                  icon: 'plus',
                  label: 'New run',
                  className: 'desktop-rail-new',
                  appearance: 'outlined',
                  title: commandTitle('texra.mainView.reset', 'New run'),
                  onClick: returnToLauncher,
                })}
              </header>
              <div class="desktop-rail-tabs">${railTabs}</div>
              <footer class="desktop-rail-footer">
                ${renderLabeledActionButton({
                  icon: 'gear',
                  text: 'Settings',
                  className: 'desktop-rail-settings',
                  appearance: 'plain',
                  title: commandTitle('texra.openSettings', 'Settings'),
                  onClick: () => openWorkspaceTab('settings'),
                })}
              </footer>
            </aside>
            <main class="desktop-center" id="desktop-center">
              <section
                class="desktop-pane"
                data-pane="launcher"
                ?hidden=${showConversation}
              >
                ${
                  hasWorkspace
                    ? html`
                        <section class="desktop-launcher-surface">
                          ${mainView}
                        </section>
                      `
                    : noWorkspacePlaceholder
                }
              </section>
              <section
                class="desktop-pane"
                data-pane="conversation"
                ?hidden=${!showConversation}
              >
                ${conversationView}
              </section>
            </main>
          </div>
        </section>
        <section
          class="desktop-tab-pane"
          data-tab-pane="settings"
          ?hidden=${current.kind !== 'settings'}
        >
          ${settingsView}
        </section>
        <section
          class="desktop-tab-pane"
          data-tab-pane="logs"
          ?hidden=${current.kind !== 'logs'}
        >
          ${logsPane}
        </section>
        <section
          class="desktop-tab-pane"
          data-tab-pane="editor"
          ?hidden=${current.kind !== 'editor'}
        >
          ${editorPane.element}
        </section>
        <section
          class="desktop-tab-pane"
          data-tab-pane="terminal"
          ?hidden=${current.kind !== 'terminal'}
        >
          ${terminalPane.element}
        </section>
        <!--
          Browser tabs render in a main-process WebContentsView layered over
          this window, so the renderer only reserves the rectangle it should
          occupy. This slot is measured in syncBrowserViewBounds.
        -->
        <section
          class="desktop-tab-pane"
          id="desktop-browser-slot"
          data-tab-pane="browser"
          ?hidden=${current.kind !== 'browser'}
        ></section>
      </div>
    </section>
  `;
}

function rerenderShell(): void {
  render(shellTemplate(), appRoot);
  // Sync the rail tabs' properties from progressState every render. (Lit's
  // property assignment is idempotent + diffed via Object.is, so this is
  // cheap.) `<stream-tabs>` reads these as plain @property values, not via
  // SignalWatcher.
  railTabs.streams = tabStreams$.get();
  railTabs.activeStreamId = activeStreamId$.get();
  railTabs.filter = streamFilter$.get();
  railTabs.streamStates = streamStates$.get();
  railTabs.pendingApprovalStreamIds = pendingApprovalIds$.get();
  railTabs.childStreamsByParent = childStreamsByParent$.get();
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
      <section
        class="desktop-bootstrap-fallback"
        role="alert"
        aria-live="assertive"
      >
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
    hasAnyStreams$.get();
    tabStreams$.get();
    streamFilter$.get();
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
      rerenderShell();
      shellWatcher.watch();
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
// the common case, and an overlay made those mutually exclusive.

type ShowSettingsArgs = Parameters<DesktopCommandActions['showSettings']>;

function openSettingsTab(
  tabIndex?: ShowSettingsArgs[0],
  agentSubTab?: ShowSettingsArgs[1],
): void {
  openWorkspaceTab('settings');
  if (tabIndex == null) return;
  window.postMessage(
    buildDesktopSettingsTabMessage(tabIndex, agentSubTab),
    getWindowTargetOrigin(),
  );
}

// =============================================================================
// Onboarding + command palette
// =============================================================================

const firstRunWalkthrough = bootstrapFailed
  ? undefined
  : createFirstRunWalkthrough({
      document,
      dismiss: () => postMessage(DESKTOP_ONBOARDING_COMMANDS.DISMISS),
      setRoute,
      openMultiAgent: () => openSettingsTab(SETTINGS_TAB.MULTI_AGENT),
    });
if (firstRunWalkthrough) appRoot.append(firstRunWalkthrough.element);

const commandPalette = bootstrapFailed
  ? undefined
  : createDesktopCommandPalette({
      document,
      canOpen: () => !firstRunWalkthrough?.isVisible(),
      actions: {
        showRoute: setRoute,
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
        openWorkspaceInNewWindow: () => {
          postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_IN_NEW_WINDOW);
        },
        showFirstRunWalkthrough: () => {
          firstRunWalkthrough?.show();
        },
        resetMainView: () => {
          returnToLauncher();
          window.postMessage(
            buildDesktopMainViewResetMessage(),
            getWindowTargetOrigin(),
          );
        },
      },
      getStreams: () => streams$.get(),
    });
if (commandPalette) appRoot.append(commandPalette.element);

function openCommandPalette(): void {
  commandPalette?.open();
}

function switchToStream(streamId: StreamTabId): void {
  if (!appState.get().streamById.has(streamId)) return;
  appState.set(
    mutate(appState.get(), (draft) => {
      draft.activeStreamId = streamId;
    }),
  );
  postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, { stream: streamId });
  setRoute('progress');
}

// Clear the active stream so the center swaps back to <main-app>. PRD § 6:
// "Composer pinned at the bottom of <main-app>; follow-up at the bottom of
// <stream-conversation>" — returning to launcher is just nulling the active id.
function returnToLauncher(): void {
  appState.set(
    mutate(appState.get(), (draft) => {
      draft.activeStreamId = null;
    }),
  );
  setRouteState('main');
}

// Bridge for legacy `desktop:setRoute` IPC (menu items, command palette).
// Each route resolves to the tab that now owns its surface; 'main' additionally
// clears the active stream so the workspace tab shows the launcher.
function setRoute(route: DesktopRoute): void {
  setRouteState(route);
  if (bootstrapFailed) return;
  if (route === 'main') {
    returnToLauncher();
    return;
  }
  const kind = tabKindForRoute(route);
  openWorkspaceTab(kind);
  // Opening the Logs tab must also fetch a snapshot; the pane renders whatever
  // it last received, which on first open is a placeholder.
  if (kind === 'logs') logsController.open();
}

window.addEventListener('message', (event) => {
  const routeParsed = DesktopSetRouteMessageSchema.safeParse(event.data);
  if (routeParsed.success) {
    setRoute(routeParsed.data.route);
    return;
  }
  const onboardingParsed = DesktopOnboardingSetStateMessageSchema.safeParse(
    event.data,
  );
  if (onboardingParsed.success) {
    if (onboardingParsed.data.shouldShow) {
      firstRunWalkthrough?.show();
    } else {
      firstRunWalkthrough?.hide();
    }
    return;
  }
  const themeParsed = SetThemeMessageSchema.safeParse(event.data);
  if (themeParsed.success) {
    applyDesktopTheme(themeParsed.data.theme);
    return;
  }
  const logParsed = DesktopSetLogMessageSchema.safeParse(event.data);
  if (logParsed.success) {
    logsController.applySnapshot(logParsed.data);
    return;
  }
  const diffParsed = DesktopShowDiffMessageSchema.safeParse(event.data);
  if (diffParsed.success) {
    diffOverlay.open(diffParsed.data);
    return;
  }
  if (DesktopCloseDiffMessageSchema.safeParse(event.data).success) {
    diffOverlay.close();
    return;
  }
  const pdfParsed = DesktopShowPdfMessageSchema.safeParse(event.data);
  if (pdfParsed.success) {
    pdfOverlay.open(pdfParsed.data);
    return;
  }
  if (DesktopClosePdfMessageSchema.safeParse(event.data).success) {
    pdfOverlay.close();
    return;
  }
  const promptParsed = DesktopShowPromptMessageSchema.safeParse(event.data);
  if (promptParsed.success) {
    promptOverlay.open(promptParsed.data);
    return;
  }
  if (handleWorkspaceMessage(event.data)) return;
  // Progress view messages: dispatch directly into the shared messageDispatcher
  // — no need to mount <progress-app> for plumbing. PRD § 7.C.
  if (isProgressOutboundMessage(event.data)) {
    dispatchMessage(event.data);
    return;
  }
});

/**
 * Handles main-process replies for the editor, terminal, and browser panes.
 * Returns true when the message was claimed, so the caller stops dispatching.
 */
function handleWorkspaceMessage(data: unknown): boolean {
  const listed = DesktopFilesListedMessageSchema.safeParse(data);
  if (listed.success) {
    pendingFileList?.resolve(listed.data.files);
    pendingFileList = undefined;
    return true;
  }
  const read = DesktopFileReadMessageSchema.safeParse(data);
  if (read.success) {
    settlePending(pendingFileReads, read.data.path, (request) =>
      request.resolve(read.data.contents),
    );
    return true;
  }
  const written = DesktopFileWrittenMessageSchema.safeParse(data);
  if (written.success) {
    settlePending(pendingFileWrites, written.data.path, (request) =>
      request.resolve(''),
    );
    return true;
  }
  const fileError = DesktopFileErrorMessageSchema.safeParse(data);
  if (fileError.success) {
    const error = new Error(fileError.data.message);
    // An empty path marks a listing failure; anything else is a specific file's
    // read or write. Reject both queues for that path: only one will be
    // populated, and leaving the other pending would hang the editor.
    if (!fileError.data.path) {
      pendingFileList?.reject(error);
      pendingFileList = undefined;
    } else {
      settlePending(pendingFileReads, fileError.data.path, (request) =>
        request.reject(error),
      );
      settlePending(pendingFileWrites, fileError.data.path, (request) =>
        request.reject(error),
      );
    }
    return true;
  }
  const terminalData = DesktopTerminalDataMessageSchema.safeParse(data);
  if (terminalData.success) {
    terminalPane.write(terminalData.data.sessionId, terminalData.data.data);
    return true;
  }
  const terminalExit = DesktopTerminalExitMessageSchema.safeParse(data);
  if (terminalExit.success) {
    terminalPane.reportExit(
      terminalExit.data.sessionId,
      terminalExit.data.exitCode,
    );
    return true;
  }
  const terminalError = DesktopTerminalErrorMessageSchema.safeParse(data);
  if (terminalError.success) {
    terminalPane.reportError(
      terminalError.data.sessionId,
      terminalError.data.message,
    );
    return true;
  }
  const browserState = DesktopBrowserStateMessageSchema.safeParse(data);
  if (browserState.success) {
    // Only the title is surfaced today: it renames the tab so a browser tab
    // reads as its page rather than a generic "Browser".
    const { tabId, title } = browserState.data;
    const tab = tabState.tabs.find((entry) => entry.id === tabId);
    if (tab && title && tab.title !== title) {
      updateTabs({
        ...tabState,
        tabs: tabState.tabs.map((entry) =>
          entry.id === tabId ? { ...entry, title } : entry,
        ),
      });
    }
    return true;
  }
  return false;
}

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
  railTabs.addEventListener('stream-switch', ((e: CustomEvent) => {
    handleStreamSwitch(e);
    // Switching to a stream pulls the user out of the launcher view.
    setRouteState('progress');
  }) as EventListener);
  railTabs.addEventListener(
    'stream-delete',
    handleStreamDelete as EventListener,
  );
  railTabs.addEventListener(
    'filter-change',
    handleFilterChange as EventListener,
  );
  railTabs.addEventListener('delete-all', handleDeleteAll as EventListener);
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
    'followup-request-options',
    handleFollowupRequestOptions,
  );
  conversationView.addEventListener('followup-setup', ((e: CustomEvent) =>
    sendFollowupCommand(
      PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP,
      e,
    )) as EventListener);
  conversationView.addEventListener('followup-run', ((e: CustomEvent) =>
    sendFollowupCommand(
      PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP,
      e,
    )) as EventListener);
  conversationView.addEventListener(
    'followup-change',
    handleFollowUpChange as EventListener,
  );
  conversationView.addEventListener(
    'followup-send',
    handleFollowUpSend as EventListener,
  );
  conversationView.addEventListener('followup-polish', handleFollowUpPolish);
  conversationView.addEventListener(
    'followup-clear',
    handleFollowUpClear as EventListener,
  );
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
}

function postWebviewReady(): void {
  // The desktop main process expects `WEBVIEW_READY` from both 'main' and
  // 'progress' views to drive startup messages + a full progress sync. The
  // single renderer now plays both roles.
  postMessage(COMMON_COMMANDS.WEBVIEW_READY, { view: 'main' });
  postMessage(COMMON_COMMANDS.WEBVIEW_READY, { view: 'progress' });
}

function applyDesktopTheme(theme: DesktopThemeKind): void {
  applyHostBodyTheme(theme);
  diffOverlay.setTheme(theme);
}
