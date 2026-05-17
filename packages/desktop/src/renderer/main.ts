import './styles.css';
import './themeTokens.css';

import '@shared/wa';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, nothing, render, type TemplateResult } from 'lit';
import { create as mutate } from 'mutative';
import { COMMON_COMMANDS } from '@common/webview/commands';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
import '@progressView/frontend';
import '@progressView/frontend/components/TexraDiffView';
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
import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
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
  streams$,
  tabStreams$,
} from '@progressView/frontend/progressState';
import '@settingsView/frontend';
import '@webview/frontend';
import { postMessage } from '@shared/hostBridge';
import type { StreamTabId } from '@shared/schemas';
import { Signal } from '@shared/signals';
import {
  SetThemeMessageSchema,
  type SetThemeMessage,
} from '@shared/schemas/commonViewMessages';
import {
  ProgressViewOutboundMessageSchema,
  type ProgressViewOutboundMessage,
} from '@shared/schemas/progressView';
import type { DesktopThemeKind } from '@shared/constants/desktopTheme';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import {
  applyHostBodyTheme,
  getWindowTargetOrigin,
} from '@shared/wa/hostTheme';
import { waIcon, type TeXRAIconName } from '@shared/wa/webAwesomeIcons';

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
  formatDesktopAccelerator,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandId,
} from '../desktopCommandSurface';
import {
  DESKTOP_ONBOARDING_COMMANDS,
  DesktopOnboardingSetStateMessageSchema,
  type DesktopOnboardingSetStateMessage,
} from '../desktopOnboardingMessages';
import {
  DesktopShowDiffMessageSchema,
  DesktopCloseDiffMessageSchema,
  type DesktopShowDiffMessage,
  type DesktopCloseDiffMessage,
} from '../desktopDiffMessages';
import {
  DesktopShowPdfMessageSchema,
  DesktopClosePdfMessageSchema,
  isSafeAbsolutePdfPath,
  type DesktopShowPdfMessage,
  type DesktopClosePdfMessage,
} from '../desktopPdfMessages';
import {
  DESKTOP_SETUP_TERMINAL_COMMANDS,
  DesktopSetupTerminalShowMessageSchema,
  DesktopSetupTerminalAppendMessageSchema,
  DesktopSetupTerminalCompleteMessageSchema,
  type DesktopSetupTerminalShowMessage,
  type DesktopSetupTerminalAppendMessage,
  type DesktopSetupTerminalCompleteMessage,
  type DesktopSetupTerminalStatus,
} from '../desktopSetupTerminalMessages';
import { createDesktopCommandPalette } from './desktopCommandPalette';
import { createFirstRunWalkthrough } from './desktopOnboarding';
import { getRendererPlatform } from './rendererPlatform';
import type WaDrawer from '@awesome.me/webawesome/dist/components/drawer/drawer.js';
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
// `currentRoute` survives only as a backwards-compat hook so existing IPC
// (`desktop:setRoute` from menu/command-palette) still reaches the right
// surface. `'main' | 'progress'` map to the center pane (progress = focus
// the active stream); `'settings'` opens the overlay; `'logs'` opens the
// drawer. The four-route tab bar is gone.

let currentRoute: DesktopRoute = 'main';
const hasWorkspace = window.texraDesktop?.hasWorkspace ?? true;
const rendererPlatform = getRendererPlatform(document.defaultView);
const desktopCommandEntriesById = new Map(
  getDesktopCommandMenuEntries(undefined, rendererPlatform).map((entry) => [
    entry.id,
    entry,
  ]),
);

function commandTitle(commandId: DesktopCommandId, label: string): string {
  const entry = desktopCommandEntriesById.get(commandId);
  const shortcut = formatDesktopAccelerator(
    entry?.accelerator,
    rendererPlatform,
  );
  return shortcut ? `${label} - ${shortcut}` : label;
}

function shortcutTitle(label: string, accelerator: string): string {
  const shortcut = formatDesktopAccelerator(accelerator, rendererPlatform);
  return shortcut ? `${label} - ${shortcut}` : label;
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
};

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
      <ul class="desktop-empty-workspace-capabilities">
        <li>Select TeX, Markdown, or text files from the opened folder.</li>
        <li>Run workflow or tool-use agents with the chosen model.</li>
        <li>Review progress, logs, and generated outputs in one window.</li>
      </ul>
      <div class="desktop-empty-workspace-actions">
        <wa-button
          appearance="filled"
          variant="brand"
          class="desktop-primary-button"
          @click=${() =>
            postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER)}
        >
          ${waIcon('folder-open', { slot: 'start' })} Open Folder
        </wa-button>
        <wa-button
          appearance="outlined"
          class="desktop-secondary-button"
          @click=${openLogsDrawer}
        >
          ${waIcon('file-lines', { slot: 'start' })} Logs
        </wa-button>
      </div>
    </section>
  `;
}

function emptyStreamsTemplate(): TemplateResult {
  return html`
    <section class="desktop-empty-streams" aria-label="First run suggestions">
      <div class="desktop-empty-streams-copy">
        <h2>Start from the launcher</h2>
        <p>Choose files and an agent above before the first run.</p>
        <p class="desktop-empty-streams-example">
          Try: <q>polish the abstract</q>
        </p>
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
  readonly key: 'logs';
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly onClick: () => void;
}

const CHROME_ICON_BUTTONS: ReadonlyArray<ChromeIconButtonSpec> = [
  { key: 'logs', icon: 'file-lines', label: 'Logs', onClick: openLogsDrawer },
] as const;

function shellTemplate(): TemplateResult {
  const activeId = activeStreamId$.get();
  const hasStreams = hasAnyStreams$.get();
  const showConversation = activeId != null && hasStreams;
  const showLauncherEmptyState = hasWorkspace && !hasStreams;
  return html`
    <section class="desktop-shell">
      <nav class="desktop-nav" aria-label="Desktop chrome">
        <span class="desktop-brand">TeXRA</span>
        <wa-button
          class="desktop-icon-button"
          appearance="plain"
          size="small"
          ?hidden=${!showConversation}
          title=${commandTitle('texra.showMainView', 'Back to launcher')}
          aria-label="Back to launcher"
          @click=${returnToLauncher}
        >
          ${waIcon('arrow-left', { label: 'Back to launcher' })}
        </wa-button>
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
        ${CHROME_ICON_BUTTONS.map(
          (spec) => html`
            <wa-button
              class="desktop-icon-button"
              appearance="plain"
              size="small"
              data-route-button=${spec.key}
              aria-label=${spec.label}
              title=${commandTitle(
                DESKTOP_LOCAL_COMMANDS.SHOW_LOGS,
                spec.label,
              )}
              @click=${spec.onClick}
            >
              ${waIcon(spec.icon, { label: spec.label })}
            </wa-button>
          `,
        )}
      </nav>
      <div class="desktop-three-pane">
        <aside class="desktop-rail" aria-label="Sessions">
          <header class="desktop-rail-header">
            <div class="desktop-rail-header-content">
              <span class="desktop-rail-title">Sessions</span>
            </div>
            <wa-button
              class="desktop-rail-new"
              appearance="outlined"
              size="small"
              title=${commandTitle('texra.mainView.reset', 'New run')}
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
              title=${commandTitle('texra.openSettings', 'Settings')}
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
            ${hasWorkspace
              ? html`
                  <section
                    class=${showLauncherEmptyState
                      ? 'desktop-launcher-surface desktop-launcher-surface--empty'
                      : 'desktop-launcher-surface'}
                  >
                    ${mainView}
                    ${showLauncherEmptyState ? emptyStreamsTemplate() : nothing}
                  </section>
                `
              : noWorkspacePlaceholder}
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
// Diff overlay (audit item C, trajectory #18)
// =============================================================================
//
// Replaces `desktopDiffHost`'s old "open the patch in the OS editor" flow
// with an in-app `<texra-diff-view>` mounted inside a wa-dialog overlay.
// Mirrors the settings-overlay pattern so the two surfaces share UX +
// keyboard handling (Esc dismisses; clicking the close button hides the
// dialog without unmounting it).

interface DiffViewElement extends HTMLElement {
  originalText: string;
  proposedText: string;
  language: string;
}

let diffDialog: WaDialog | null = null;
let diffViewElement: DiffViewElement | null = null;
let diffTitleElement: HTMLElement | null = null;
let diffSubtitleElement: HTMLElement | null = null;

function ensureDiffDialog(): WaDialog {
  if (diffDialog) return diffDialog;
  const dialog = document.createElement('wa-dialog') as WaDialog;
  dialog.classList.add('desktop-diff-overlay');
  dialog.withoutHeader = true;
  dialog.lightDismiss = false;
  dialog.setAttribute('aria-label', 'Compare files');

  const body = document.createElement('section');
  body.classList.add('desktop-diff-body');

  const header = document.createElement('header');
  header.classList.add('desktop-diff-header');
  const titleEl = document.createElement('h2');
  titleEl.classList.add('desktop-diff-title');
  titleEl.textContent = 'Compare';
  diffTitleElement = titleEl;
  const subtitleEl = document.createElement('p');
  subtitleEl.classList.add('desktop-diff-subtitle');
  diffSubtitleElement = subtitleEl;
  header.append(titleEl, subtitleEl);

  // Lazily create the <texra-diff-view> on first show (Monaco is heavy
  // to import; defer until actually needed). The element is reused
  // across re-opens — Lit's @property setter handles content swaps.
  const view = document.createElement('texra-diff-view') as DiffViewElement;
  view.classList.add('desktop-diff-view');
  diffViewElement = view;

  body.append(header, view);
  dialog.append(body);

  // Explicit close button — wa-dialog handles Esc natively but we want a
  // visible affordance to match the settings overlay.
  const close = document.createElement('wa-button');
  close.classList.add('desktop-diff-close');
  close.setAttribute('appearance', 'plain');
  close.setAttribute('size', 'small');
  close.setAttribute('aria-label', 'Close diff');
  close.setAttribute('title', 'Close diff');
  render(waIcon('xmark'), close);
  close.addEventListener('click', () => {
    dialog.open = false;
  });
  dialog.append(close);

  appRoot.append(dialog);
  diffDialog = dialog;
  return dialog;
}

function openDiffOverlay(payload: DesktopShowDiffMessage): void {
  const dialog = ensureDiffDialog();
  if (diffTitleElement) diffTitleElement.textContent = payload.title;
  if (diffSubtitleElement) {
    // Show the proposed path (the file the user is reviewing) — fall
    // back to the original or empty string. This is purely informative;
    // payload contains the full text already.
    diffSubtitleElement.textContent =
      payload.proposedPath ?? payload.originalPath ?? '';
  }
  if (diffViewElement) {
    diffViewElement.originalText = payload.originalText;
    diffViewElement.proposedText = payload.proposedText;
    diffViewElement.language = payload.language;
  }
  dialog.open = true;
}

function closeDiffOverlay(): void {
  if (diffDialog) diffDialog.open = false;
}

// =============================================================================
// PDF preview overlay (audit item B, trajectory #17)
// =============================================================================
//
// Replaces `desktopPreviewHost.openBuildDisplay`'s old "open the PDF in
// the OS viewer" flow with an in-app `<iframe src="file://...">` mounted
// inside a wa-dialog overlay — Electron's bundled Chromium renders PDFs
// natively, so no extra dependency is required. Mirrors the diff
// overlay shape so the two surfaces share UX + keyboard handling
// (Esc dismisses; clicking the close button hides the dialog without
// unmounting it).
//
// Note: this is the second overlay (settings was first via the
// drawer/dialog refactor; diff via #3815). If a third overlay arrives
// we should extract a shared `createOverlay()` factory; today the
// duplication is small enough that an abstraction would be premature.

let pdfDialog: WaDialog | null = null;
let pdfFrameElement: HTMLIFrameElement | null = null;
let pdfTitleElement: HTMLElement | null = null;
let pdfSubtitleElement: HTMLElement | null = null;

function ensurePdfDialog(): WaDialog {
  if (pdfDialog) return pdfDialog;
  const dialog = document.createElement('wa-dialog') as WaDialog;
  dialog.classList.add('desktop-pdf-overlay');
  dialog.withoutHeader = true;
  dialog.lightDismiss = false;
  dialog.setAttribute('aria-label', 'PDF preview');

  const body = document.createElement('section');
  body.classList.add('desktop-pdf-body');

  const header = document.createElement('header');
  header.classList.add('desktop-pdf-header');
  const titleEl = document.createElement('h2');
  titleEl.classList.add('desktop-pdf-title');
  titleEl.textContent = 'Preview';
  pdfTitleElement = titleEl;
  const subtitleEl = document.createElement('p');
  subtitleEl.classList.add('desktop-pdf-subtitle');
  pdfSubtitleElement = subtitleEl;
  header.append(titleEl, subtitleEl);

  // Use an `<iframe>` (not `<webview>`) — `<webview>` requires
  // `webviewTag: true` in webPreferences which we don't enable.
  // Electron's main BrowserWindow renders PDFs in iframes via the
  // bundled Chromium PDF plugin, no flag needed. The src is set
  // when the overlay is opened (we keep it empty initially so
  // dormant dialogs don't load anything).
  const frame = document.createElement('iframe');
  frame.classList.add('desktop-pdf-frame');
  frame.setAttribute('title', 'PDF preview');
  // sandbox: allow same-origin so the PDF viewer's controls (toolbar,
  // page nav) work; deny scripts so a malformed PDF can't run JS into
  // our renderer. The Chromium PDF viewer itself runs in a separate
  // origin so this restriction is benign.
  frame.setAttribute('sandbox', 'allow-same-origin');
  pdfFrameElement = frame;

  body.append(header, frame);
  dialog.append(body);

  // Explicit close button — wa-dialog handles Esc natively, but the
  // visible affordance matches the settings + diff overlays.
  const close = document.createElement('wa-button');
  close.classList.add('desktop-pdf-close');
  close.setAttribute('appearance', 'plain');
  close.setAttribute('size', 'small');
  close.setAttribute('aria-label', 'Close PDF preview');
  close.setAttribute('title', 'Close PDF preview');
  render(waIcon('xmark'), close);
  close.addEventListener('click', () => {
    dialog.open = false;
  });
  dialog.append(close);

  // Clear the iframe src when the dialog hides so we don't keep the
  // PDF resident in memory across closes. Re-opening reassigns the
  // src in `openPdfOverlay`.
  dialog.addEventListener('wa-after-hide', () => {
    if (pdfFrameElement) pdfFrameElement.removeAttribute('src');
  });

  appRoot.append(dialog);
  pdfDialog = dialog;
  return dialog;
}

function openPdfOverlay(payload: DesktopShowPdfMessage): void {
  // Extra defense in depth: even though the schema parsed `pdfPath`
  // as a non-empty string, the renderer enforces an absolute-fs-path
  // contract before assigning to `iframe.src`. Anything that smells
  // like a non-`file:` URL is rejected (logged + ignored). The main
  // process is the only producer today, but the renderer should not
  // trust messages it didn't originate (Cursor Bugbot guidance).
  if (!isSafeAbsolutePdfPath(payload.pdfPath)) {
    console.error(
      '[desktop] desktopPdfOverlay: rejected unsafe PDF path',
      payload.pdfPath,
    );
    return;
  }
  const dialog = ensurePdfDialog();
  if (pdfTitleElement) pdfTitleElement.textContent = payload.title;
  if (pdfSubtitleElement) pdfSubtitleElement.textContent = payload.pdfPath;
  if (pdfFrameElement) {
    pdfFrameElement.src = pdfPathToFileUrl(payload.pdfPath);
  }
  dialog.open = true;
}

/**
 * Convert an absolute filesystem path (already shape-validated by
 * `isSafeAbsolutePdfPath`) into a `file:` URL safe for an iframe `src`.
 *
 * - posix `/abs/path.pdf` → `file:///abs/path.pdf`
 * - Windows drive `C:\path\file.pdf` → `file:///C:/path/file.pdf`
 * - Windows UNC `\\server\share\file.pdf` → `file://server/share/file.pdf`
 *
 * Per-segment `encodeURIComponent` percent-encodes `#`, `?`, spaces, and
 * other URL-unsafe characters that `encodeURI` leaves intact, so the
 * iframe doesn't truncate or alter the loaded path. Bot review (#3816)
 * caught the prior `file://${encodeURI(path)}` form which produced
 * invalid URLs for Windows drive-letter and UNC paths.
 */
function pdfPathToFileUrl(absolutePath: string): string {
  const normalised = absolutePath.replaceAll('\\', '/');
  const encodePath = (path: string): string =>
    path.split('/').map(encodeURIComponent).join('/');
  // Windows UNC: //server/share/file → file://server/share/file
  if (normalised.startsWith('//')) {
    return `file://${encodePath(normalised.slice(2))}`;
  }
  // posix absolute: /abs/file → file:///abs/file
  if (normalised.startsWith('/')) {
    return `file:///${encodePath(normalised.slice(1))}`;
  }
  // Windows drive: C:/path/file → file:///C:/path/file
  // Drive letter colon stays unescaped; only the rest of the segments are
  // percent-encoded.
  const driveMatch = normalised.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) {
    return `file:///${driveMatch[1]}:/${encodePath(driveMatch[2])}`;
  }
  // Defensive fallback — shouldn't happen because `isSafeAbsolutePdfPath`
  // already accepted only the three shapes above. Encode the whole string
  // so we still produce a parseable URL.
  return `file:///${encodeURIComponent(normalised)}`;
}

function closePdfOverlay(): void {
  if (pdfDialog) pdfDialog.open = false;
}

// =============================================================================
// Setup command terminal overlay
// =============================================================================

const SETUP_TERMINAL_OUTPUT_LIMIT = 200_000;

let setupTerminalDialog: WaDialog | null = null;
let setupTerminalTitleElement: HTMLElement | null = null;
let setupTerminalSubtitleElement: HTMLElement | null = null;
let setupTerminalStatusElement: HTMLElement | null = null;
let setupTerminalCommandElement: HTMLElement | null = null;
let setupTerminalOutputElement: HTMLPreElement | null = null;
let setupTerminalCancelButton: HTMLElement | null = null;
let setupTerminalCopyOutputButton: HTMLElement | null = null;
let setupTerminalActiveRunId: string | null = null;
let setupTerminalCommandText = '';
let setupTerminalOutputText = '';

function ensureSetupTerminalDialog(): WaDialog {
  if (setupTerminalDialog) return setupTerminalDialog;
  const dialog = document.createElement('wa-dialog') as WaDialog;
  dialog.classList.add('desktop-setup-terminal-overlay');
  dialog.withoutHeader = true;
  dialog.lightDismiss = false;
  dialog.setAttribute('aria-label', 'Setup command output');

  const body = document.createElement('section');
  body.classList.add('desktop-setup-terminal-body');

  const header = document.createElement('header');
  header.classList.add('desktop-setup-terminal-header');
  const headerText = document.createElement('div');
  headerText.classList.add('desktop-setup-terminal-heading');
  const titleEl = document.createElement('h2');
  titleEl.classList.add('desktop-setup-terminal-title');
  titleEl.textContent = 'Setup';
  setupTerminalTitleElement = titleEl;
  const subtitleEl = document.createElement('p');
  subtitleEl.classList.add('desktop-setup-terminal-subtitle');
  setupTerminalSubtitleElement = subtitleEl;
  headerText.append(titleEl, subtitleEl);

  const statusEl = document.createElement('span');
  statusEl.classList.add('desktop-setup-terminal-status');
  setupTerminalStatusElement = statusEl;
  header.append(headerText, statusEl);

  const commandEl = document.createElement('code');
  commandEl.classList.add('desktop-setup-terminal-command');
  setupTerminalCommandElement = commandEl;

  const outputEl = document.createElement('pre');
  outputEl.classList.add('desktop-setup-terminal-output');
  outputEl.textContent = '';
  setupTerminalOutputElement = outputEl;

  const actions = document.createElement('footer');
  actions.classList.add('desktop-setup-terminal-actions');
  const copyCommand = createSetupTerminalButton('copy', 'Copy command');
  copyCommand.addEventListener('click', () => {
    void copyText(setupTerminalCommandText);
  });
  const copyOutput = createSetupTerminalButton('copy', 'Copy output');
  copyOutput.addEventListener('click', () => {
    void copyText(setupTerminalOutputText);
  });
  setupTerminalCopyOutputButton = copyOutput;
  const cancel = createSetupTerminalButton('xmark', 'Cancel');
  cancel.addEventListener('click', () => {
    if (setupTerminalActiveRunId) {
      postMessage(DESKTOP_SETUP_TERMINAL_COMMANDS.CANCEL, {
        runId: setupTerminalActiveRunId,
      });
      setSetupTerminalStatus('cancelled');
    }
  });
  setupTerminalCancelButton = cancel;
  const close = createSetupTerminalButton('xmark', 'Close');
  close.addEventListener('click', () => {
    dialog.open = false;
  });
  actions.append(copyCommand, copyOutput, cancel, close);

  body.append(header, commandEl, outputEl, actions);
  dialog.append(body);
  appRoot.append(dialog);
  setupTerminalDialog = dialog;
  return dialog;
}

function createSetupTerminalButton(
  icon: TeXRAIconName,
  label: string,
): HTMLElement {
  const button = document.createElement('wa-button');
  button.classList.add('desktop-setup-terminal-button');
  button.setAttribute('appearance', 'outlined');
  button.setAttribute('size', 'small');
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
  render(html`${waIcon(icon)}<span>${label}</span>`, button);
  return button;
}

async function copyText(text: string): Promise<void> {
  if (!text) return;
  await navigator.clipboard?.writeText(text);
}

function openSetupTerminalOverlay(
  payload: DesktopSetupTerminalShowMessage,
): void {
  const dialog = ensureSetupTerminalDialog();
  setupTerminalActiveRunId = payload.runId;
  setupTerminalCommandText = payload.shellCommand;
  setupTerminalOutputText = '';
  if (setupTerminalTitleElement) {
    setupTerminalTitleElement.textContent = payload.title;
  }
  if (setupTerminalSubtitleElement) {
    setupTerminalSubtitleElement.textContent = payload.cwd;
  }
  if (setupTerminalCommandElement) {
    setupTerminalCommandElement.textContent = payload.shellCommand;
  }
  if (setupTerminalOutputElement) setupTerminalOutputElement.textContent = '';
  setSetupTerminalStatus('running');
  dialog.open = true;
}

function appendSetupTerminalOutput(
  payload: DesktopSetupTerminalAppendMessage,
): void {
  if (payload.runId !== setupTerminalActiveRunId) return;
  setupTerminalOutputText += payload.chunk;
  if (setupTerminalOutputText.length > SETUP_TERMINAL_OUTPUT_LIMIT) {
    setupTerminalOutputText = setupTerminalOutputText.slice(
      -SETUP_TERMINAL_OUTPUT_LIMIT,
    );
  }
  if (!setupTerminalOutputElement) return;
  setupTerminalOutputElement.textContent = setupTerminalOutputText;
  setupTerminalOutputElement.scrollTop =
    setupTerminalOutputElement.scrollHeight;
  setupTerminalCopyOutputButton?.toggleAttribute('disabled', false);
}

function completeSetupTerminalOverlay(
  payload: DesktopSetupTerminalCompleteMessage,
): void {
  if (payload.runId !== setupTerminalActiveRunId) return;
  setupTerminalOutputText = payload.output || setupTerminalOutputText;
  if (setupTerminalOutputElement) {
    setupTerminalOutputElement.textContent = setupTerminalOutputText;
    setupTerminalOutputElement.scrollTop =
      setupTerminalOutputElement.scrollHeight;
  }
  setSetupTerminalStatus(payload.status);
  setupTerminalActiveRunId = null;
}

function setSetupTerminalStatus(status: DesktopSetupTerminalStatus): void {
  if (setupTerminalStatusElement) {
    setupTerminalStatusElement.textContent = formatSetupTerminalStatus(status);
    setupTerminalStatusElement.dataset.status = status;
  }
  const running = status === 'running';
  setupTerminalCancelButton?.toggleAttribute('disabled', !running);
  setupTerminalCopyOutputButton?.toggleAttribute(
    'disabled',
    setupTerminalOutputText.length === 0,
  );
}

function formatSetupTerminalStatus(status: DesktopSetupTerminalStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'succeeded':
      return 'Finished';
    case 'failed':
      return 'Failed';
    case 'timed-out':
      return 'Timed out';
    case 'cancelled':
      return 'Cancelled';
  }
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

function isDesktopCloseDiffMessage(
  message: unknown,
): message is DesktopCloseDiffMessage {
  return DesktopCloseDiffMessageSchema.safeParse(message).success;
}

function isDesktopClosePdfMessage(
  message: unknown,
): message is DesktopClosePdfMessage {
  return DesktopClosePdfMessageSchema.safeParse(message).success;
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
  const diffParsed = DesktopShowDiffMessageSchema.safeParse(event.data);
  if (diffParsed.success) {
    openDiffOverlay(diffParsed.data);
    return;
  }
  if (isDesktopCloseDiffMessage(event.data)) {
    closeDiffOverlay();
    return;
  }
  const pdfParsed = DesktopShowPdfMessageSchema.safeParse(event.data);
  if (pdfParsed.success) {
    openPdfOverlay(pdfParsed.data);
    return;
  }
  if (isDesktopClosePdfMessage(event.data)) {
    closePdfOverlay();
    return;
  }
  const setupTerminalShowParsed =
    DesktopSetupTerminalShowMessageSchema.safeParse(event.data);
  if (setupTerminalShowParsed.success) {
    openSetupTerminalOverlay(setupTerminalShowParsed.data);
    return;
  }
  const setupTerminalAppendParsed =
    DesktopSetupTerminalAppendMessageSchema.safeParse(event.data);
  if (setupTerminalAppendParsed.success) {
    appendSetupTerminalOutput(setupTerminalAppendParsed.data);
    return;
  }
  const setupTerminalCompleteParsed =
    DesktopSetupTerminalCompleteMessageSchema.safeParse(event.data);
  if (setupTerminalCompleteParsed.success) {
    completeSetupTerminalOverlay(setupTerminalCompleteParsed.data);
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
      return mutate(prev, (draft) => {
        if (!('ui' in draft)) return;
        const ui = (
          draft as {
            ui: {
              shouldFocusFollowUp?: boolean;
              polishedText?: string | null;
              transcribedText?: string | null;
            };
          }
        ).ui;
        ui.shouldFocusFollowUp = false;
        ui.polishedText = null;
        ui.transcribedText = null;
      });
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
export {
  setRoute,
  openSettingsOverlay,
  openLogsDrawer,
  openDiffOverlay,
  closeDiffOverlay,
  openPdfOverlay,
  closePdfOverlay,
};
