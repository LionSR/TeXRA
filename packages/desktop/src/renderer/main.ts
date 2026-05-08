import './styles.css';
import './themeTokens.css';

import '@shared/wa';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import type WaDrawer from '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import { html, render, type TemplateResult } from 'lit';
import { Signal } from '@shared/signals';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import {
  applyHostBodyTheme,
  getWindowTargetOrigin,
} from '@shared/wa/hostTheme';
import { waIcon, type TeXRAIconName } from '@shared/wa/webAwesomeIcons';

import { COMMON_COMMANDS } from '@common/webview/commands';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
import { postMessage } from '@shared/hostBridge';
import type { DesktopThemeKind } from '@shared/constants/desktopTheme';
import {
  SetThemeMessageSchema,
  type SetThemeMessage,
} from '@shared/schemas/commonViewMessages';
import {
  ProgressViewOutboundMessageSchema,
  type ProgressViewOutboundMessage,
} from '@shared/schemas/progressView';
import { create as mutate } from 'mutative';

import '@progressView/frontend';
import '@progressView/frontend/components/TexraDiffView';
import '@settingsView/frontend';
import '@webview/frontend';
import {
  activeStreamId$,
  appState,
  childStreamsByParent$,
  hasAnyStreams$,
  pendingApprovalIds$,
  permissions$,
  placement,
  setStreamLogsForId,
  setStreamStateForId,
  streamFilter$,
  streamStates$,
  tabStreams$,
} from '@progressView/frontend/progressState';
import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
import {
  handleDeleteAll,
  handleFileAction,
  handleFilterChange,
  handleFollowupRequestOptions,
  handleFollowUpChange,
  handleFollowUpClear,
  handleFollowUpPolish,
  handleFollowUpSend,
  handlePermissionAction,
  handleStreamDelete,
  handleStreamSwitch,
  handleToolbarCommand,
  runCompileFixer,
  sendFollowupCommand,
  type FrontendEventHandlerContext,
} from '@progressView/frontend/eventHandlers';

import {
  DesktopSetRouteMessageSchema,
  type DesktopRoute,
  type DesktopSetRouteMessage,
} from '../desktopShellMessages';
import {
  DESKTOP_LOG_COMMANDS,
  DesktopSetLogMessageSchema,
  type DesktopSetLogMessage,
} from '../desktopLogMessages';
import {
  buildDesktopMainViewResetMessage,
  buildDesktopSettingsTabMessage,
  DESKTOP_LOCAL_COMMANDS,
} from '../desktopCommandSurface';
import {
  DESKTOP_ONBOARDING_COMMANDS,
  DesktopOnboardingSetStateMessageSchema,
  type DesktopOnboardingSetStateMessage,
} from '../desktopOnboardingMessages';
import { createDesktopCommandPalette } from './desktopCommandPalette';
import { createFirstRunWalkthrough } from './desktopOnboarding';

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
// `currentRoute` survives only as a backwards-compat hook so existing IPC
// (`desktop:setRoute` from menu/command-palette) still reaches the right
// surface. `'main' | 'progress'` map to the center pane (progress = focus
// the active stream); `'settings'` opens the overlay; `'logs'` opens the
// drawer. The four-route tab bar is gone.

let currentRoute: DesktopRoute = 'main';
const hasWorkspace = window.texraDesktop?.hasWorkspace ?? true;

// `<settings-app>` lives inside the wa-dialog overlay below; `<main-app>` and
// `<stream-conversation>` mount directly in the center pane. These are
// instantiated once and slotted into the shell template via Lit's DOM-node
// interpolation so Lit preserves their internal state across re-renders.
const mainView: HTMLElement = document.createElement('main-app');
mainView.setAttribute('data-desktop-view', 'main');
const noWorkspacePlaceholder: HTMLElement = document.createElement('section');
if (!hasWorkspace) {
  // Empty-state placeholder when no workspace is open. The launcher cannot
  // run anything without a workspace; show a minimal prompt instead. We
  // render this as a sibling and hide `<main-app>` rather than swapping the
  // tag so the test surface (and downstream tooling) always sees the
  // canonical `<main-app>` mount.
  noWorkspacePlaceholder.className = 'desktop-empty-workspace';
  render(emptyWorkspaceTemplate(), noWorkspacePlaceholder);
}

const conversationView: HTMLElement = document.createElement(
  'stream-conversation',
);
conversationView.setAttribute('data-desktop-view', 'progress');

// Left rail: a fresh <stream-tabs> mount wired to module-level progressState.
// PRD § 7.D requires mounting <stream-tabs> directly (not inside <progress-app>).
const railTabs = document.createElement('stream-tabs') as HTMLElement & {
  streams: unknown;
  activeStreamId: string | null;
  filter: unknown;
  streamStates: unknown;
  pendingApprovalStreamIds: unknown;
  childStreamsByParent: unknown;
  compact: boolean;
};
railTabs.compact = true;

const settingsView: HTMLElement = document.createElement('settings-app');
settingsView.setAttribute('data-desktop-view', 'settings');

const logsContainer: HTMLElement = document.createElement('div');
logsContainer.setAttribute('data-desktop-view', 'logs');
logsContainer.className = 'desktop-log-host';

function emptyWorkspaceTemplate(): TemplateResult {
  return html`
    <section class="desktop-empty-workspace-panel">
      <h1>Open a folder to use TeXRA</h1>
      <p>
        TeXRA desktop needs a workspace before it can discover files, run
        agents, and place outputs.
      </p>
      <div class="desktop-empty-workspace-actions">
        <wa-button
          appearance="filled"
          variant="brand"
          class="desktop-primary-button"
          @click=${() =>
            postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER)}
        >
          Open Folder
        </wa-button>
        <wa-button
          appearance="outlined"
          class="desktop-secondary-button"
          @click=${openLogsDrawer}
        >
          Logs
        </wa-button>
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
// `appState`, `permissions$`, `placement` are module-level signals that all
// the imported components subscribe to via SignalWatcher, so changes here
// propagate into both `<stream-tabs>` and `<stream-conversation>`.

function getEventHandlerContext(): FrontendEventHandlerContext {
  return {
    getState: () => appState.get(),
    setState: (updater) => {
      appState.set(updater(appState.get()));
    },
    setStreamState: (streamId, updater) =>
      setStreamStateForId(streamId, updater),
    setStreamLogs: (streamId, updater) => setStreamLogsForId(streamId, updater),
    // savePrefs intentionally omitted on desktop — filter persistence isn't
    // wired (yet). Filter changes still apply for the active session.
  };
}

function getMessageHandlerContext() {
  return {
    ...getEventHandlerContext(),
    getPermissions: () => permissions$.get(),
    setPermissions: (next: ReturnType<typeof permissions$.get>) => {
      permissions$.set(next);
    },
    setPlacement: (next: ReturnType<typeof placement.get>) => {
      placement.set(next);
    },
  };
}

function isProgressOutboundMessage(
  raw: unknown,
): raw is ProgressViewOutboundMessage {
  return ProgressViewOutboundMessageSchema.safeParse(raw).success;
}

// =============================================================================
// Shell template
// =============================================================================

interface ChromeIconButtonSpec {
  readonly key: 'settings' | 'logs';
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly onClick: () => void;
}

const CHROME_ICON_BUTTONS: ReadonlyArray<ChromeIconButtonSpec> = [
  {
    key: 'settings',
    icon: 'gear',
    label: 'Settings',
    onClick: openSettingsOverlay,
  },
  { key: 'logs', icon: 'file-lines', label: 'Logs', onClick: openLogsDrawer },
] as const;

function shellTemplate(): TemplateResult {
  const activeId = activeStreamId$.get();
  const showConversation = activeId != null && hasAnyStreams$.get();
  return html`
    <section class="desktop-shell">
      <nav class="desktop-nav" aria-label="Desktop chrome">
        <span class="desktop-brand">TeXRA</span>
        <wa-button
          class="desktop-back-button"
          appearance="plain"
          size="small"
          ?hidden=${!showConversation}
          title="Back to launcher"
          aria-label="Back to launcher"
          @click=${returnToLauncher}
        >
          ${waIcon('arrow-left', { slot: 'start' })} Launcher
        </wa-button>
        <wa-button
          class="desktop-command-button"
          appearance="outlined"
          size="small"
          aria-haspopup="dialog"
          @click=${openCommandPalette}
        >
          Commands
        </wa-button>
        <wa-button
          class="desktop-folder-button"
          appearance="outlined"
          size="small"
          @click=${openWorkspaceFolder}
        >
          ${waIcon('folder-open', { slot: 'start' })} Open Folder
        </wa-button>
        ${CHROME_ICON_BUTTONS.map(
          (spec) => html`
            <wa-button
              class="desktop-icon-button"
              appearance="plain"
              size="small"
              data-route-button=${spec.key}
              aria-label=${spec.label}
              title=${spec.label}
              @click=${spec.onClick}
            >
              ${waIcon(spec.icon)}
            </wa-button>
          `,
        )}
      </nav>
      <div class="desktop-three-pane">
        <aside class="desktop-rail" aria-label="Sessions">
          <header class="desktop-rail-header">
            <span class="desktop-rail-title">Sessions</span>
            <wa-button
              class="desktop-rail-new"
              appearance="outlined"
              size="small"
              title="New run"
              aria-label="New run"
              @click=${returnToLauncher}
            >
              ${waIcon('plus')}
            </wa-button>
          </header>
          <div class="desktop-rail-tabs">${railTabs}</div>
          <footer class="desktop-rail-footer">
            <wa-button
              class="desktop-rail-settings"
              appearance="plain"
              size="small"
              @click=${openSettingsOverlay}
            >
              ${waIcon('gear', { slot: 'start' })} Settings
            </wa-button>
          </footer>
        </aside>
        <main class="desktop-center" id="desktop-center">
          <section
            class="desktop-pane"
            data-pane="launcher"
            ?hidden=${showConversation}
          >
            ${hasWorkspace ? mainView : noWorkspacePlaceholder}
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

function renderBootstrapFallback(error: unknown): void {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'TeXRA could not finish starting up.';
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
              @click=${() => {
                try {
                  renderLogViewer();
                  rerenderShell();
                  // Recovery must wire rail tabs / conversation events and
                  // install the signal watcher — without these the recovered
                  // shell renders but stays inert (rail clicks ignored,
                  // signal changes don't trigger rerenders). Bot review
                  // #3801 caught this regression.
                  wireRailTabs();
                  wireConversation();
                  installShellSignalWatcher();
                  bootstrapFailed = false;
                  postMessage(DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE);
                  postWebviewReady();
                } catch (recoveryError) {
                  console.error(
                    'TeXRA desktop renderer recovery failed',
                    recoveryError,
                  );
                  bootstrapFailed = true;
                  renderBootstrapFallback(recoveryError);
                }
              }}
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

// =============================================================================
// Logs drawer
// =============================================================================

interface LogViewerState {
  meta: string;
  text: string;
}

let logViewerState: LogViewerState = {
  meta: 'Recent redacted log entries appear here.',
  text: 'Open Logs to load recent entries.',
};

let logsDrawer: WaDrawer | null = null;

function ensureLogsDrawer(): WaDrawer {
  if (logsDrawer) return logsDrawer;
  const drawer = document.createElement('wa-drawer') as WaDrawer;
  drawer.classList.add('desktop-logs-drawer');
  drawer.setAttribute('label', 'Desktop Logs');
  drawer.setAttribute('placement', 'bottom');
  drawer.append(logsContainer);
  appRoot.append(drawer);
  logsDrawer = drawer;
  return drawer;
}

function openLogsDrawer(): void {
  const drawer = ensureLogsDrawer();
  currentRoute = 'logs';
  document.body.dataset.desktopRoute = 'logs';
  drawer.open = true;
  requestLogSnapshot();
}

let shellWatcherInstalled = false;

function installShellSignalWatcher(): void {
  if (shellWatcherInstalled) return;
  shellWatcherInstalled = true;
  // Subscribe to module-level progress signals so the center-pane swap
  // (launcher ↔ conversation) and the rail tab properties stay live. Use
  // `Signal.subtle.Watcher` from @lit-labs/signals (TC39 polyfill) — this
  // is what `SignalWatcher(LitElement)` wraps internally. We schedule the
  // re-render on a microtask so multiple synchronous signal writes batch.
  //
  // The watcher pattern: after `notify` fires, the watcher pauses tracking;
  // we must read the pending computed (which re-runs and re-establishes
  // dependencies) and call `watch()` again to re-arm. This is the same
  // pattern @lit-labs/signals' `SignalWatcher` mixin uses internally.
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
  renderLogViewer();
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
  const dialog = document.createElement('wa-dialog') as WaDialog;
  dialog.classList.add('desktop-settings-overlay');
  dialog.withoutHeader = true;
  dialog.lightDismiss = false;
  dialog.setAttribute('aria-label', 'Settings');
  dialog.setAttribute('data-route-button', 'settings');
  // Settings-app fills the dialog body. We append it directly so subsequent
  // re-opens reuse the same instance (preserving tab selection and state).
  dialog.append(settingsView);
  // Add an explicit close button (gear toggle dismiss flow). Esc is handled
  // natively by wa-dialog.
  const close = document.createElement('wa-button');
  close.classList.add('desktop-settings-close');
  close.setAttribute('appearance', 'plain');
  close.setAttribute('size', 'small');
  close.setAttribute('aria-label', 'Close settings');
  close.setAttribute('title', 'Close settings');
  render(waIcon('xmark'), close);
  close.addEventListener('click', () => {
    dialog.open = false;
  });
  dialog.append(close);
  appRoot.append(dialog);
  settingsDialog = dialog;
  return dialog;
}

function openSettingsOverlay(): void {
  const dialog = ensureSettingsDialog();
  currentRoute = 'settings';
  document.body.dataset.desktopRoute = 'settings';
  dialog.open = true;
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
    });
if (firstRunWalkthrough) appRoot.append(firstRunWalkthrough.element);

const commandPalette = bootstrapFailed
  ? undefined
  : createDesktopCommandPalette({
      document,
      canOpen: () => !firstRunWalkthrough?.isVisible(),
      actions: {
        showRoute: setRoute,
        showSettings: (tabIndex, agentSubTab) => {
          openSettingsOverlay();
          if (tabIndex == null) return;
          window.postMessage(
            buildDesktopSettingsTabMessage(tabIndex, agentSubTab),
            getWindowTargetOrigin(),
          );
        },
        openDesktopDocs: () => {
          postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS);
        },
        openLogFolder: () => {
          postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER);
        },
        openWorkspaceFolder: () => {
          postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER);
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
    });
if (commandPalette) appRoot.append(commandPalette.element);

function openCommandPalette(): void {
  commandPalette?.open();
}

function openWorkspaceFolder(): void {
  postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER);
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
  currentRoute = 'main';
  document.body.dataset.desktopRoute = 'main';
}

function isDesktopSetRouteMessage(
  message: unknown,
): message is DesktopSetRouteMessage {
  return DesktopSetRouteMessageSchema.safeParse(message).success;
}

function isDesktopOnboardingSetStateMessage(
  message: unknown,
): message is DesktopOnboardingSetStateMessage {
  return DesktopOnboardingSetStateMessageSchema.safeParse(message).success;
}

function isDesktopSetLogMessage(
  message: unknown,
): message is DesktopSetLogMessage {
  return DesktopSetLogMessageSchema.safeParse(message).success;
}

function isThemeMessage(message: unknown): message is SetThemeMessage {
  return SetThemeMessageSchema.safeParse(message).success;
}

// Bridge for legacy `desktop:setRoute` IPC. The shell no longer has four
// routes, so map the old route names onto the new surfaces:
//   - 'main' / 'progress' → center pane (clear active stream for 'main')
//   - 'settings' → overlay
//   - 'logs' → drawer
function setRoute(route: DesktopRoute): void {
  currentRoute = route;
  document.body.dataset.desktopRoute = route;
  if (bootstrapFailed) return;
  switch (route) {
    case 'main':
      returnToLauncher();
      // returnToLauncher rerenders via the effect.
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
  if (isDesktopSetRouteMessage(event.data)) {
    setRoute(event.data.route);
    return;
  }
  if (isDesktopOnboardingSetStateMessage(event.data)) {
    if (event.data.shouldShow) {
      firstRunWalkthrough?.show();
    } else {
      firstRunWalkthrough?.hide();
    }
    return;
  }
  if (isThemeMessage(event.data)) {
    applyDesktopTheme(event.data.theme);
    return;
  }
  if (isDesktopSetLogMessage(event.data)) {
    renderLogSnapshot(event.data);
    return;
  }
  // Progress view messages: dispatch directly into the shared messageDispatcher
  // — no need to mount <progress-app> for plumbing. PRD § 7.C.
  if (isProgressOutboundMessage(event.data)) {
    dispatchMessage(event.data, getMessageHandlerContext());
    return;
  }
});

// =============================================================================
// Wire <stream-tabs> + <stream-conversation> events to shared handlers
// =============================================================================

function wireRailTabs(): void {
  railTabs.addEventListener('stream-switch', ((e: CustomEvent) => {
    handleStreamSwitch(e, getEventHandlerContext());
    // Switching to a stream pulls the user out of the launcher view. The
    // effect-driven rerender will swap to the conversation pane.
    currentRoute = 'progress';
    document.body.dataset.desktopRoute = 'progress';
  }) as EventListener);
  railTabs.addEventListener('stream-delete', ((e: CustomEvent) =>
    handleStreamDelete(e, getEventHandlerContext())) as EventListener);
  railTabs.addEventListener('filter-change', ((e: CustomEvent) =>
    handleFilterChange(e, getEventHandlerContext())) as EventListener);
  railTabs.addEventListener('delete-all', () => handleDeleteAll());
}

function wireConversation(): void {
  const ctx = () => getEventHandlerContext();
  conversationView.addEventListener('stream-switch', ((e: CustomEvent) => {
    handleStreamSwitch(e, ctx());
  }) as EventListener);
  conversationView.addEventListener('toolbar-command', ((e: CustomEvent) =>
    handleToolbarCommand(e, ctx())) as EventListener);
  conversationView.addEventListener('permission-action', ((e: CustomEvent) =>
    handlePermissionAction(e, getMessageHandlerContext())) as EventListener);
  conversationView.addEventListener('file-action', ((e: CustomEvent) =>
    handleFileAction(e)) as EventListener);
  conversationView.addEventListener('compile-fixer-run', () =>
    runCompileFixer(ctx()),
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
  conversationView.addEventListener('followup-send', () =>
    handleFollowUpSend(ctx()),
  );
  conversationView.addEventListener('followup-polish', () =>
    handleFollowUpPolish(ctx()),
  );
  conversationView.addEventListener('followup-clear', () =>
    handleFollowUpClear(ctx()),
  );
  // followup-focus-complete: clear the focus/polish/transcribe trigger flags.
  conversationView.addEventListener('followup-focus-complete', () => {
    const streamId = appState.get().activeStreamId;
    if (!streamId) return;
    setStreamStateForId(streamId, (prev) => {
      // The followup-focus-complete handler in ProgressApp is a no-op when
      // not a tool-use state; mirror that here. Importing the type guard
      // would create a circular dep, so use structural shape.
      if (!('ui' in prev)) return prev;
      const next = mutate(prev, (draft) => {
        if ('ui' in draft) {
          (
            draft as {
              ui: {
                shouldFocusFollowUp?: boolean;
                polishedText?: string | null;
                transcribedText?: string | null;
              };
            }
          ).ui.shouldFocusFollowUp = false;
          (
            draft as {
              ui: {
                shouldFocusFollowUp?: boolean;
                polishedText?: string | null;
                transcribedText?: string | null;
              };
            }
          ).ui.polishedText = null;
          (
            draft as {
              ui: {
                shouldFocusFollowUp?: boolean;
                polishedText?: string | null;
                transcribedText?: string | null;
              };
            }
          ).ui.transcribedText = null;
        }
      });
      return next;
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
}

function logViewerTemplate(state: LogViewerState): TemplateResult {
  const action = (
    icon: 'rotate-right' | 'copy' | 'download' | 'folder-open',
    label: string,
    onClick: () => void,
  ): TemplateResult =>
    renderLabeledActionButton({
      icon,
      text: label,
      className: 'desktop-secondary-button',
      appearance: 'outlined',
      onClick,
    });
  return html`
    <section class="desktop-log-viewer">
      <header class="desktop-log-viewer-header">
        <div>
          <h2>Desktop Logs</h2>
          <p>${state.meta}</p>
        </div>
        <div class="desktop-log-viewer-actions">
          ${action('rotate-right', 'Refresh', requestLogSnapshot)}
          ${action('copy', 'Copy', () =>
            postMessage(DESKTOP_LOG_COMMANDS.COPY_LOG),
          )}
          ${action('download', 'Export', () =>
            postMessage(DESKTOP_LOG_COMMANDS.EXPORT_LOG),
          )}
          ${action('folder-open', 'Open Folder', () =>
            postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER),
          )}
        </div>
      </header>
      <pre class="desktop-log-viewer-output">${state.text}</pre>
    </section>
  `;
}

function renderLogViewer(): void {
  render(logViewerTemplate(logViewerState), logsContainer);
}

function requestLogSnapshot(): void {
  postMessage(DESKTOP_LOG_COMMANDS.REQUEST_LOG);
}

function renderLogSnapshot(message: DesktopSetLogMessage): void {
  const path = message.log.path ?? 'desktop log file';
  logViewerState = {
    text: message.log.text || 'No desktop log entries yet.',
    meta: message.log.truncated
      ? `Showing the most recent redacted entries from ${path}.`
      : `Showing redacted entries from ${path}.`,
  };
  renderLogViewer();
}

// Re-export references that downstream modules (or future hooks) may want to
// drive imperatively. Keeps the API surface explicit even though the desktop
// shell currently consumes them directly.
export { setRoute, openSettingsOverlay, openLogsDrawer };
