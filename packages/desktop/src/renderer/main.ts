import './styles.css';
import './themeTokens.css';

import '@shared/wa';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tree/tree.js';
import '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';
import type WaTreeItem from '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';
import { html, nothing, render, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { renderEmptyState } from '@shared/wa/emptyState';
import { waIcon, type TeXRAIconName } from '@shared/wa/webAwesomeIcons';

import { COMMON_COMMANDS } from '@common/webview/commands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { postMessage } from '@shared/hostBridge';
import type { DesktopThemeKind } from '@shared/constants/desktopTheme';
import {
  SetThemeMessageSchema,
  type SetThemeMessage,
} from '@shared/schemas/commonViewMessages';
import '@progressView/frontend';
import '@progressView/frontend/components/TexraDiffView';
import '@settingsView/frontend';
import '@webview/frontend';

import {
  DesktopRouteSchema,
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
import {
  DESKTOP_WORKSPACE_EXPLORER_COMMANDS,
  DesktopWorkspaceTreeMessageSchema,
  type DesktopWorkspaceFileCategory,
  type DesktopWorkspaceTreeMessage,
} from '../desktopWorkspaceExplorerMessages';
import { createDesktopCommandPalette } from './desktopCommandPalette';
import { createFirstRunWalkthrough } from './desktopOnboarding';

interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: WorkspaceTreeNode[];
  categories?: string[];
}

const DESKTOP_ROUTES = DesktopRouteSchema.options;

const root = document.querySelector<HTMLElement>('#app');

if (root == null) {
  throw new Error('TeXRA desktop renderer root was not found.');
}

const appRoot = root;

// Module-level reactive state for the desktop shell. Mutating these and then
// calling `rerenderShell()` is the canonical way to update the chrome. Avoid
// post-render imperative DOM mutations on Lit-rendered nodes — they will be
// reset on the next render pass.
let currentRoute: DesktopRoute = 'main';
const hasWorkspace = window.texraDesktop?.hasWorkspace ?? true;
let selectedExplorerFile = '';

// Standalone web components are instantiated once and slotted into the shell
// template via Lit's DOM-node interpolation. Lit preserves these nodes across
// re-renders, so the route components keep their internal state.
const mainView: Element = hasWorkspace
  ? document.createElement('main-app')
  : createNoWorkspacePlaceholder('launcher');
mainView.setAttribute('data-desktop-view', 'main');

const progressView: Element = hasWorkspace
  ? document.createElement('progress-app')
  : createNoWorkspacePlaceholder('progress');
progressView.setAttribute('data-desktop-view', 'progress');

const settingsView: Element = document.createElement('settings-app');
settingsView.setAttribute('data-desktop-view', 'settings');

const logsContainer: HTMLElement = document.createElement('div');
logsContainer.setAttribute('data-desktop-view', 'logs');
logsContainer.className = 'desktop-log-host';

// The chrome only exposes Settings and Logs as utility icons (the four-route
// top nav was removed). Other routes are reachable through the command
// palette and the "Back to Launcher" affordance below.
const CHROME_ROUTE_BUTTONS: ReadonlyArray<DesktopRoute> = ['settings', 'logs'];

interface ChromeIconButtonSpec {
  readonly route: DesktopRoute;
  readonly icon: TeXRAIconName;
  readonly label: string;
}

const CHROME_ICON_BUTTONS: ReadonlyArray<ChromeIconButtonSpec> = [
  { route: 'settings', icon: 'gear', label: 'Settings' },
  { route: 'logs', icon: 'file-lines', label: 'Logs' },
] as const;

// Sanity check: the icon-button list must stay aligned with the chrome route
// list above so future contributors update both together.
if (
  CHROME_ICON_BUTTONS.length !== CHROME_ROUTE_BUTTONS.length ||
  CHROME_ICON_BUTTONS.some((spec, i) => spec.route !== CHROME_ROUTE_BUTTONS[i])
) {
  throw new Error('Chrome icon button list is out of sync with route list.');
}

function shellTemplate(): TemplateResult {
  return html`
    <section class="desktop-shell">
      <nav class="desktop-nav" aria-label="Desktop chrome">
        <span class="desktop-brand">TeXRA</span>
        <wa-button
          class="desktop-back-button"
          appearance="plain"
          size="small"
          ?hidden=${currentRoute === 'main'}
          @click=${() => setRoute('main')}
        >
          ${waIcon('arrow-left', { slot: 'start' })} Back to Launcher
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
              data-route-button=${spec.route}
              aria-pressed=${String(currentRoute === spec.route)}
              aria-label=${spec.label}
              title=${spec.label}
              @click=${() => toggleRoute(spec.route)}
            >
              ${waIcon(spec.icon)}
            </wa-button>
          `,
        )}
      </nav>
      <div class="desktop-workbench">
        <aside
          class="desktop-explorer"
          id="desktop-explorer"
          aria-label="Workspace Explorer"
        >
          ${explorerTemplate()}
        </aside>
        <main class="desktop-view" id="desktop-view">
          <section
            class="desktop-route"
            data-route="main"
            ?hidden=${currentRoute !== 'main'}
          >
            ${mainView}
          </section>
          <section
            class="desktop-route"
            data-route="progress"
            ?hidden=${currentRoute !== 'progress'}
          >
            ${progressView}
          </section>
          <section
            class="desktop-route"
            data-route="settings"
            ?hidden=${currentRoute !== 'settings'}
          >
            ${settingsView}
          </section>
          <section
            class="desktop-route"
            data-route="logs"
            ?hidden=${currentRoute !== 'logs'}
          >
            ${logsContainer}
          </section>
        </main>
      </div>
    </section>
  `;
}

function rerenderShell(): void {
  render(shellTemplate(), appRoot);
}

function renderBootstrapFallback(error: unknown): void {
  // Last-resort fallback when the main shell cannot mount. This must NOT
  // depend on any custom element or async work — if the shell crashed before
  // reaching the chrome render, we still need to draw something so the user
  // is not staring at a blank white window. The user-visible failure mode
  // we are guarding against is a thrown decrypt during early IPC (e.g., the
  // macOS keychain prompt is denied) propagating into the bootstrap promise
  // chain and aborting render() before any pixels are painted.
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
                // Hide the fallback so the partial shell (if any) becomes
                // visible. The renderer can still drive routes via the
                // command palette even when secrets are unavailable.
                const node = appRoot.querySelector(
                  '.desktop-bootstrap-fallback',
                );
                if (node instanceof HTMLElement) node.hidden = true;
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

let bootstrapFailed = false;
try {
  // Render the log viewer template into its dedicated container so that
  // re-renders driven by log-snapshot updates do not stomp the shell.
  renderLogViewer();
  rerenderShell();
} catch (error) {
  bootstrapFailed = true;
  console.error('TeXRA desktop renderer bootstrap failed', error);
  renderBootstrapFallback(error);
}

// If the shell failed to mount, skip everything that depends on its DOM —
// command palette, walkthrough, and IPC requests. The fallback UI gives the
// user a way to reload or proceed without saved secrets.
if (bootstrapFailed) {
  // Surface unhandled IPC rejections that arrive after the fallback so they
  // do not silently disappear into the console.
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled rejection after bootstrap failure', event.reason);
  });
}

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
          setRoute('settings');
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
          setRoute('main');
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

function setRoute(route: DesktopRoute): void {
  currentRoute = route;
  document.body.dataset.desktopRoute = route;
  if (bootstrapFailed) return;
  rerenderShell();
  if (route === 'logs') requestLogSnapshot();
}

function toggleRoute(route: DesktopRoute): void {
  // Toggle back to the launcher when the same chrome button is pressed again,
  // so the icons feel like a "go to / dismiss" affordance.
  setRoute(currentRoute === route ? 'main' : route);
}

window.addEventListener('message', (event) => {
  if (isDesktopSetRouteMessage(event.data)) {
    setRoute(event.data.route);
  } else if (isDesktopOnboardingSetStateMessage(event.data)) {
    if (event.data.shouldShow) {
      firstRunWalkthrough?.show();
    } else {
      firstRunWalkthrough?.hide();
    }
  } else if (isThemeMessage(event.data)) {
    applyDesktopTheme(event.data.theme);
  } else if (isWorkspaceTreeMessage(event.data)) {
    receiveWorkspaceTree(event.data);
  } else if (isDesktopSetLogMessage(event.data)) {
    renderLogSnapshot(event.data);
  }
});
if (!bootstrapFailed) {
  requestWorkspaceTree();
  postMessage(DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE);
}

function applyDesktopTheme(theme: DesktopThemeKind): void {
  // Body and html classList mutation is OK here: those elements live OUTSIDE
  // the Lit-rendered desktop shell, so the next `rerenderShell()` cannot stomp
  // these classes. Theme state is intentionally not part of the shell template.
  document.body.classList.remove(
    'vscode-light',
    'vscode-dark',
    'vscode-high-contrast',
    'texra-light',
    'texra-dark',
    'texra-high-contrast',
  );
  document.body.classList.add(`vscode-${theme}`, `texra-${theme}`);
  document.body.dataset.vscodeThemeKind = theme;
  // Apply Web Awesome's native color-scheme class on the document root so
  // WA's --wa-* dark-mode overrides activate (per WA theming model).
  const docRoot = document.documentElement;
  docRoot.classList.remove('wa-light', 'wa-dark');
  docRoot.classList.add(theme === 'light' ? 'wa-light' : 'wa-dark');
}

function getWindowTargetOrigin(): string {
  // Electron loads this renderer over file://, where origin is "null".
  return window.location.origin && window.location.origin !== 'null'
    ? window.location.origin
    : '*';
}

const EMPTY_WORKSPACE_COPY = {
  launcher: {
    title: 'Open a folder to use the launcher',
    body: 'TeXRA desktop needs a workspace before it can discover files, run agents, and place outputs.',
  },
  progress: {
    title: 'Open a folder to view workspace progress',
    body: 'Progress details are tied to workspace runs. Start from a workspace to restore and follow sessions here.',
  },
} as const;

function createNoWorkspacePlaceholder(kind: 'launcher' | 'progress'): Element {
  const container = document.createElement('section');
  container.className = 'desktop-empty-workspace';
  const { title, body } = EMPTY_WORKSPACE_COPY[kind];
  render(
    renderEmptyState({
      className: 'desktop-empty-workspace-panel',
      icon: 'folder-open',
      title,
      body,
      headingTag: 'h1',
      actions: [
        {
          label: 'Open Folder',
          appearance: 'filled',
          variant: 'brand',
          className: 'desktop-primary-button',
          onClick: () =>
            postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
        },
        {
          label: 'Logs',
          appearance: 'outlined',
          className: 'desktop-secondary-button',
          onClick: () => postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER),
        },
      ],
    }),
    container,
  );
  return container;
}

interface LogViewerState {
  meta: string;
  text: string;
}

let logViewerState: LogViewerState = {
  meta: 'Recent redacted log entries appear here.',
  text: 'Open Logs to load recent entries.',
};

function logViewerTemplate(state: LogViewerState): TemplateResult {
  const action = (
    icon: 'rotate-right' | 'copy' | 'download' | 'folder-open',
    label: string,
    onClick: () => void,
  ): TemplateResult => html`
    <wa-button
      class="desktop-secondary-button"
      appearance="outlined"
      size="small"
      @click=${onClick}
    >
      ${waIcon(icon, { slot: 'start' })} ${label}
    </wa-button>
  `;
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

function isWorkspaceTreeMessage(
  message: unknown,
): message is DesktopWorkspaceTreeMessage {
  return DesktopWorkspaceTreeMessageSchema.safeParse(message).success;
}

function requestWorkspaceTree(): void {
  if (!hasWorkspace) {
    explorerState = { kind: 'no-workspace' };
    rerenderShell();
    return;
  }
  postMessage(DESKTOP_WORKSPACE_EXPLORER_COMMANDS.REQUEST_TREE);
}

type ExplorerState =
  | { kind: 'loading'; title: string }
  | { kind: 'no-workspace' }
  | { kind: 'tree'; title: string; tree: readonly WorkspaceTreeNode[] };

let explorerState: ExplorerState = { kind: 'loading', title: 'Workspace' };

function receiveWorkspaceTree(message: DesktopWorkspaceTreeMessage): void {
  explorerState = {
    kind: 'tree',
    title: message.workspaceName ?? 'Workspace',
    tree: message.tree,
  };
  rerenderShell();
}

function explorerTemplate(): TemplateResult {
  if (explorerState.kind === 'no-workspace')
    return explorerNoWorkspaceTemplate();
  if (explorerState.kind === 'loading') {
    return html`
      ${explorerHeaderTemplate(explorerState.title, true)}
      <p class="desktop-explorer-status">Loading workspace files...</p>
    `;
  }
  if (explorerState.tree.length === 0) {
    return html`
      ${explorerHeaderTemplate(explorerState.title)}
      <p class="desktop-explorer-status">
        No selectable workspace files found.
      </p>
    `;
  }
  return html`
    ${explorerHeaderTemplate(explorerState.title)}
    <wa-tree
      class="desktop-explorer-tree"
      selection="single"
      @wa-selection-change=${handleExplorerSelectionChange}
    >
      ${treeNodesTemplate(explorerState.tree, 0)}
    </wa-tree>
    <section class="desktop-explorer-selection" aria-live="polite">
      ${selectionPanelTemplate(explorerState.tree)}
    </section>
  `;
}

function handleExplorerSelectionChange(
  event: CustomEvent<{ selection: WaTreeItem[] }>,
): void {
  const selected = event.detail.selection[0];
  if (selected == null) return;
  const filePath = selected.dataset.filePath;
  if (filePath == null || filePath === '') return;
  selectExplorerFile(filePath);
}

function explorerNoWorkspaceTemplate(): TemplateResult {
  return renderEmptyState({
    className: 'desktop-explorer-empty',
    icon: 'folder-open',
    title: 'No workspace',
    body: 'Open a folder before selecting files for agents.',
    // Explorer is a subordinate sidebar; keep its title at h2 so it does not
    // compete with the workbench's h1 main empty-state heading.
    headingTag: 'h2',
    actions: [
      {
        label: 'Open Folder',
        appearance: 'filled',
        variant: 'brand',
        className: 'desktop-primary-button',
        onClick: () =>
          postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
      },
    ],
  });
}

function explorerHeaderTemplate(
  title: string,
  loading = false,
): TemplateResult {
  return html`
    <header class="desktop-explorer-header">
      <span class="desktop-explorer-title">${title}</span>
      <wa-button
        class="desktop-explorer-icon-button"
        appearance="plain"
        size="small"
        title="Refresh workspace files"
        aria-label="Refresh workspace files"
        ?disabled=${loading || !hasWorkspace}
        @click=${requestWorkspaceTree}
      >
        ${waIcon('rotate-right')}
      </wa-button>
    </header>
  `;
}

function treeNodesTemplate(
  nodes: readonly WorkspaceTreeNode[],
  depth: number,
): TemplateResult {
  return html`
    ${repeat(
      nodes,
      (node) => node.path,
      (node) => treeNodeTemplate(node, depth),
    )}
  `;
}

function treeNodeTemplate(
  node: WorkspaceTreeNode,
  depth: number,
): TemplateResult {
  if (node.type === 'directory') {
    return html`
      <wa-tree-item class="desktop-explorer-directory" ?expanded=${depth < 2}>
        ${waIcon('folder')}
        <span class="desktop-explorer-name">${node.name}</span>
        ${treeNodesTemplate(node.children ?? [], depth + 1)}
      </wa-tree-item>
    `;
  }
  return html`
    <wa-tree-item
      class="desktop-explorer-file"
      title=${node.path}
      data-file-path=${node.path}
      ?selected=${selectedExplorerFile === node.path}
      @dblclick=${() => openWorkspaceFile(node.path)}
    >
      ${waIcon('file-lines')}
      <span class="desktop-explorer-name">${node.name}</span>
      <span class="desktop-explorer-category-strip">
        ${(node.categories ?? []).map(
          (category) => html`
            <span
              class="desktop-explorer-category-dot"
              title=${category}
              data-category=${category}
            ></span>
          `,
        )}
      </span>
    </wa-tree-item>
  `;
}

function selectionPanelTemplate(
  tree: readonly WorkspaceTreeNode[],
): TemplateResult | string {
  const node = selectedExplorerFile
    ? findFileNode(tree, selectedExplorerFile)
    : undefined;
  if (!node) {
    return 'Select a file to open it or attach it to the launcher.';
  }
  return html`
    <div class="desktop-explorer-selected-path">${node.path}</div>
    <div class="desktop-explorer-selection-actions">
      ${selectionActionTemplate('Open', () => openWorkspaceFile(node.path))}
      ${(node.categories ?? []).map((category) => {
        const typedCategory = parseExplorerCategory(category);
        return typedCategory
          ? selectionActionTemplate(`Use as ${typedCategory}`, () =>
              selectWorkspaceFile(typedCategory, node.path),
            )
          : nothing;
      })}
    </div>
  `;
}

function selectionActionTemplate(
  label: string,
  onClick: () => void,
): TemplateResult {
  return html`
    <wa-button
      class="desktop-secondary-button"
      appearance="outlined"
      size="small"
      @click=${onClick}
    >
      ${label}
    </wa-button>
  `;
}

function selectExplorerFile(filePath: string): void {
  selectedExplorerFile = filePath;
  rerenderShell();
}

function findFileNode(
  nodes: readonly WorkspaceTreeNode[],
  filePath: string,
): WorkspaceTreeNode | undefined {
  for (const node of nodes) {
    if (node.type === 'file' && node.path === filePath) return node;
    const childMatch = node.children
      ? findFileNode(node.children, filePath)
      : undefined;
    if (childMatch) return childMatch;
  }
  return undefined;
}

function parseExplorerCategory(
  value: string,
): DesktopWorkspaceFileCategory | undefined {
  return ['input', 'reference', 'auxiliary', 'media'].includes(value)
    ? (value as DesktopWorkspaceFileCategory)
    : undefined;
}

function openWorkspaceFile(filePath: string): void {
  postMessage(DESKTOP_WORKSPACE_EXPLORER_COMMANDS.OPEN_FILE, { filePath });
}

function selectWorkspaceFile(
  fileType: DesktopWorkspaceFileCategory,
  filePath: string,
): void {
  postMessage(DESKTOP_WORKSPACE_EXPLORER_COMMANDS.SELECT_FILE, {
    fileType,
    filePath,
  });
  if (fileType === 'input') {
    postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, { baseFile: filePath });
  }
  setRoute('main');
}
