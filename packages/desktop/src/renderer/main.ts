import './styles.css';
import './themeTokens.css';

import '@shared/wa';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, render, type TemplateResult } from 'lit';
import { create as mutate } from 'mutative';
import '@progressView/frontend';
import '@progressView/frontend/components/TexraDiffView';
import type { StreamTabs } from '@progressView/frontend/components/StreamTabs';
import {
  createHostEventHandlerContext,
  createHostMessageHandlerContext,
  handleDeleteAll,
  handleFileAction,
  handleFilterChange,
  handleFollowupRequestOptions,
  handleFollowUpChange,
  handleFollowUpClear,
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
  setStreamStateForId,
  streamFilter$,
  streamStates$,
  streams$,
  tabStreams$,
} from '@progressView/frontend/progressState';
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import '@settingsView/frontend';
import '@webview/frontend';
import { postMessage } from '@shared/hostBridge';
import type { StreamTabId } from '@shared/schemas';
import { Signal } from '@shared/signals';
import { SetThemeMessageSchema } from '@shared/schemas/commonViewMessages';
import {
  ProgressViewOutboundMessageSchema,
  type ProgressViewOutboundMessage,
} from '@shared/schemas/progressView';
import type { DesktopThemeKind } from '@shared/constants/desktopTheme';
import {
  applyHostBodyTheme,
  getWindowTargetOrigin,
} from '@shared/wa/hostTheme';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@shared/wa/actionButtons';

import {
  DesktopSetRouteMessageSchema,
  type DesktopRoute,
} from '../desktopShellMessages';
import { DesktopSetLogMessageSchema } from '../desktopLogMessages';
import {
  buildDesktopMainViewResetMessage,
  buildDesktopSettingsTabMessage,
  DESKTOP_LOCAL_COMMANDS,
  formatDesktopAccelerator,
  getDesktopCommandMenuEntries,
  SETTINGS_TAB,
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
import { createDesktopCommandPalette } from './desktopCommandPalette';
import { createFirstRunWalkthrough } from './desktopOnboarding';
import { getRendererPlatform } from './rendererPlatform';
import { createPdfOverlay } from './pdfOverlay';
import { createDiffOverlay } from './diffOverlay';
import { createLogsDrawer } from './logsDrawer';
import { createOverlayDialog } from './overlayDialog';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';

const root = document.querySelector<HTMLElement>('#app');

if (root == null) {
  throw new Error('TeXRA desktop renderer root was not found.');
}

const appRoot = root;

// =============================================================================
// Pane state
// =============================================================================
//
// PRD § 6 + § 7.D: replace the four-route shell with a three-pane window.
//   - Left rail: <stream-tabs> (sessions) + Settings entry
//   - Center: <main-app> when no active stream, else <stream-conversation>
//   - Right: reserved for future diff/approve UX (collapsed today)
//
// `setRouteState` survives only as a backwards-compat hook so existing IPC
// (`desktop:setRoute` from menu/command-palette) still reaches the right
// surface. `'main' | 'progress'` map to the center pane (progress = focus
// the active stream); `'settings'` opens the overlay; `'logs'` opens the
// drawer. The four-route tab bar is gone.

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

// `<settings-app>` lives inside the wa-dialog overlay below; `<main-app>` and
// `<stream-conversation>` mount directly in the center pane. These are
// instantiated once and slotted into the shell template via Lit's DOM-node
// interpolation so Lit preserves their internal state across re-renders.
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

const logsDrawer = createLogsDrawer(appRoot);
const diffOverlay = createDiffOverlay(appRoot);
const pdfOverlay = createPdfOverlay(appRoot);

function openLogsDrawer(): void {
  setRouteState('logs');
  logsDrawer.open();
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
// directly. We recreate the message-routing and event-handler context here so
// the same `messageDispatcher` + `eventHandlers` modules drive both hosts.
//
// savePrefs intentionally omitted (matching trace-viewer's use of the same
// shared contexts) — filter persistence isn't wired on desktop (yet). Filter
// changes still apply for the active session.

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
  return html`
    <section class="desktop-shell">
      <nav class="desktop-nav" aria-label="Desktop chrome">
        <span class="desktop-workspace-directory" title=${workspacePath ?? ''}>
          ${workspaceDirectoryLabel}
        </span>
        ${renderIconActionButton({
          icon: 'arrow-left',
          label: 'Back to launcher',
          className: 'desktop-icon-button',
          appearance: 'plain',
          hidden: !showConversation,
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
          Commands
        </wa-button>
        ${renderIconActionButton({
          icon: 'file-lines',
          label: 'Logs',
          className: 'desktop-icon-button',
          appearance: 'plain',
          action: 'logs',
          title: commandTitle(DESKTOP_LOCAL_COMMANDS.SHOW_LOGS, 'Logs'),
          onClick: openLogsDrawer,
        })}
      </nav>
      <div class="desktop-three-pane">
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
              onClick: openSettingsOverlay,
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
        <aside
          class="desktop-right"
          aria-label="Reserved for future diff/approve UX"
          aria-hidden="true"
          hidden
        ></aside>
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
    logsDrawer.rerenderViewer();
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
  logsDrawer.rerenderViewer();
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
// Settings overlay
// =============================================================================

let settingsDialog: WaDialog | null = null;

function ensureSettingsDialog(): WaDialog {
  if (settingsDialog) return settingsDialog;
  // Settings-app fills the dialog body. We pass it as the shell content (no
  // titled header) so subsequent re-opens reuse the same instance, preserving
  // tab selection and state.
  settingsDialog = createOverlayDialog({
    appRoot,
    prefix: 'desktop-settings',
    ariaLabel: 'Settings',
    closeLabel: 'Close settings',
    content: settingsView,
    attributes: { 'data-route-button': 'settings' },
  }).dialog;
  return settingsDialog;
}

function openSettingsOverlay(): void {
  const dialog = ensureSettingsDialog();
  setRouteState('settings');
  dialog.open = true;
}

type ShowSettingsArgs = Parameters<DesktopCommandActions['showSettings']>;

function openSettingsTab(
  tabIndex?: ShowSettingsArgs[0],
  agentSubTab?: ShowSettingsArgs[1],
): void {
  openSettingsOverlay();
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

// Bridge for legacy `desktop:setRoute` IPC. The shell no longer has four
// routes, so map the old route names onto the new surfaces:
//   - 'main' / 'progress' → center pane (clear active stream for 'main')
//   - 'settings' → overlay
//   - 'logs' → drawer
function setRoute(route: DesktopRoute): void {
  setRouteState(route);
  if (bootstrapFailed) return;
  switch (route) {
    case 'main':
      returnToLauncher();
      break;
    case 'progress':
      // No-op: the conversation pane shows automatically when activeStreamId$
      // is set. If no active stream, stay on launcher.
      rerenderShell();
      break;
    case 'settings':
      openSettingsOverlay();
      break;
    case 'logs':
      openLogsDrawer();
      break;
  }
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
    logsDrawer.applySnapshot(logParsed.data);
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
  // Progress view messages: dispatch directly into the shared messageDispatcher
  // — no need to mount <progress-app> for plumbing. PRD § 7.C.
  if (isProgressOutboundMessage(event.data)) {
    dispatchMessage(event.data, createHostMessageHandlerContext());
    return;
  }
});

// =============================================================================
// Wire <stream-tabs> + <stream-conversation> events to shared handlers
// =============================================================================

function wireRailTabs(): void {
  railTabs.addEventListener('stream-switch', ((e: CustomEvent) => {
    handleStreamSwitch(e, createHostEventHandlerContext());
    // Switching to a stream pulls the user out of the launcher view.
    setRouteState('progress');
  }) as EventListener);
  railTabs.addEventListener('stream-delete', ((e: CustomEvent) =>
    handleStreamDelete(e, createHostEventHandlerContext())) as EventListener);
  railTabs.addEventListener('filter-change', ((e: CustomEvent) =>
    handleFilterChange(e, createHostEventHandlerContext())) as EventListener);
  railTabs.addEventListener('delete-all', handleDeleteAll as EventListener);
}

function wireConversation(): void {
  const ctx = createHostEventHandlerContext;
  conversationView.addEventListener('stream-switch', ((e: CustomEvent) => {
    handleStreamSwitch(e, ctx());
  }) as EventListener);
  conversationView.addEventListener('toolbar-command', ((e: CustomEvent) =>
    handleToolbarCommand(e, ctx())) as EventListener);
  conversationView.addEventListener('permission-action', ((e: CustomEvent) =>
    handlePermissionAction(
      e,
      createHostMessageHandlerContext(),
    )) as EventListener);
  conversationView.addEventListener(
    'file-action',
    handleFileAction as EventListener,
  );
  conversationView.addEventListener('compile-fixer-run', () =>
    runCompileFixer(ctx()),
  );
  conversationView.addEventListener(
    'getting-started-action',
    handleGettingStartedAction as EventListener,
  );
  conversationView.addEventListener('followup-request-options', () =>
    handleFollowupRequestOptions(ctx()),
  );
  conversationView.addEventListener('followup-setup', ((e: CustomEvent) =>
    sendFollowupCommand(
      PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP,
      e,
      ctx(),
    )) as EventListener);
  conversationView.addEventListener('followup-run', ((e: CustomEvent) =>
    sendFollowupCommand(
      PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP,
      e,
      ctx(),
    )) as EventListener);
  conversationView.addEventListener('followup-change', ((e: CustomEvent) =>
    handleFollowUpChange(e, ctx())) as EventListener);
  conversationView.addEventListener('followup-send', ((e: CustomEvent) =>
    handleFollowUpSend(e, ctx())) as EventListener);
  conversationView.addEventListener('followup-polish', () =>
    handleFollowUpPolish(ctx()),
  );
  conversationView.addEventListener('followup-clear', ((e: CustomEvent) =>
    handleFollowUpClear(e, ctx())) as EventListener);
  // followup-focus-complete: clear the focus/polish/transcribe trigger flags.
  conversationView.addEventListener(
    'followup-focus-complete',
    clearActiveFollowUpFocusFlags,
  );
}

interface FollowUpFocusUiState {
  ui: {
    shouldFocusFollowUp?: boolean;
    polishedText?: string | null;
    transcribedText?: string | null;
  };
}

function clearActiveFollowUpFocusFlags(): void {
  const streamId = appState.get().activeStreamId;
  if (!streamId) return;
  setStreamStateForId(streamId, (prev) => {
    // The followup-focus-complete handler in ProgressApp is a no-op when
    // not a tool-use state; mirror that here. Importing the type guard
    // would create a circular dep, so match the structural shape instead.
    if (!('ui' in prev)) return prev;
    return mutate(prev, (draft) => {
      if (!('ui' in draft)) return;
      const { ui } = draft as FollowUpFocusUiState;
      ui.shouldFocusFollowUp = false;
      ui.polishedText = null;
      ui.transcribedText = null;
    });
  });
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
