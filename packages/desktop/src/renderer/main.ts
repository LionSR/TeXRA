import './styles.css';
import './themeTokens.css';
import './codiconStylesheet';

import '@shared/wa';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import type WaButton from '@awesome.me/webawesome/dist/components/button/button.js';
import { html, nothing, render, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { renderEmptyState } from '@shared/wa/emptyState';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { COMMON_COMMANDS } from '@common/webview/commands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { postMessage } from '@shared/hostBridge';
import type { DesktopThemeKind } from '@shared/constants/desktopTheme';
import {
  SetThemeMessageSchema,
  type SetThemeMessage,
} from '@shared/schemas/commonViewMessages';
import '@vscode-elements/elements/dist/bundled.js';
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

const NAV_ROUTES: ReadonlyArray<{
  readonly route: DesktopRoute;
  readonly label: string;
}> = [
  { route: 'main', label: 'Launcher' },
  { route: 'progress', label: 'Progress' },
  { route: 'settings', label: 'Settings' },
  { route: 'logs', label: 'Logs' },
];

render(
  html`
    <section class="desktop-shell">
      <nav class="desktop-nav" aria-label="Desktop views">
        ${NAV_ROUTES.map(
          ({ route, label }) => html`
            <wa-button
              class="desktop-nav-button"
              appearance="plain"
              size="small"
              role="button"
              data-route-button=${route}
              aria-pressed=${route === 'main' ? 'true' : 'false'}
            >
              ${label}
            </wa-button>
          `,
        )}
        <wa-button
          class="desktop-command-button"
          appearance="outlined"
          size="small"
          data-command-palette-button
          aria-haspopup="dialog"
        >
          Commands
        </wa-button>
        <wa-button
          class="desktop-folder-button"
          appearance="outlined"
          size="small"
          data-open-workspace-button
        >
          ${waIcon('folder-open', { slot: 'start' })} Open Folder
        </wa-button>
      </nav>
      <div class="desktop-workbench">
        <aside
          class="desktop-explorer"
          id="desktop-explorer"
          aria-label="Workspace Explorer"
        ></aside>
        <main class="desktop-view" id="desktop-view">
          ${DESKTOP_ROUTES.map(
            (route) => html`
              <section
                class="desktop-route"
                data-route=${route}
                ?hidden=${route !== 'main'}
              ></section>
            `,
          )}
        </main>
      </div>
    </section>
  `,
  appRoot,
);

const desktopViewContainer =
  appRoot.querySelector<HTMLElement>('#desktop-view');
if (desktopViewContainer == null) {
  throw new Error('TeXRA desktop view container was not found.');
}

const workspaceExplorerElement =
  appRoot.querySelector<HTMLElement>('#desktop-explorer');
if (workspaceExplorerElement == null) {
  throw new Error('TeXRA desktop workspace explorer was not found.');
}
const workspaceExplorerContainer: HTMLElement = workspaceExplorerElement;

const routeContainers = new Map<DesktopRoute, HTMLElement>();
for (const route of DESKTOP_ROUTES) {
  const container = desktopViewContainer.querySelector<HTMLElement>(
    `[data-route="${route}"]`,
  );
  if (container == null) {
    throw new Error(`TeXRA desktop route container was not found: ${route}`);
  }
  routeContainers.set(route, container);
}

const routeButtons = new Map<DesktopRoute, WaButton>();
for (const route of DESKTOP_ROUTES) {
  const button = appRoot.querySelector<WaButton>(
    `[data-route-button="${route}"]`,
  );
  if (button == null) {
    throw new Error(`TeXRA desktop route button was not found: ${route}`);
  }
  button.addEventListener('click', () => setRoute(route));
  routeButtons.set(route, button);
}

const hasWorkspace = window.texraDesktop?.hasWorkspace ?? true;
let selectedExplorerFile = '';

renderWorkspaceExplorerLoading();

if (hasWorkspace) {
  const mainApp = document.createElement('main-app');
  mainApp.setAttribute('data-desktop-view', 'main');

  const progressApp = document.createElement('progress-app');
  progressApp.setAttribute('data-desktop-view', 'progress');

  routeContainers.get('main')?.replaceChildren(mainApp);
  routeContainers.get('progress')?.replaceChildren(progressApp);
} else {
  routeContainers
    .get('main')
    ?.replaceChildren(createNoWorkspacePlaceholder('launcher'));
  routeContainers
    .get('progress')
    ?.replaceChildren(createNoWorkspacePlaceholder('progress'));
}

const settingsApp = document.createElement('settings-app');
settingsApp.setAttribute('data-desktop-view', 'settings');
routeContainers.get('settings')?.replaceChildren(settingsApp);
renderLogViewer(routeContainers.get('logs'));

const commandPaletteButton = appRoot.querySelector<WaButton>(
  '[data-command-palette-button]',
);
if (commandPaletteButton == null) {
  throw new Error('TeXRA desktop command palette button was not found.');
}

const openWorkspaceButton = appRoot.querySelector<WaButton>(
  '[data-open-workspace-button]',
);
if (openWorkspaceButton == null) {
  throw new Error('TeXRA desktop open workspace button was not found.');
}

const firstRunWalkthrough = createFirstRunWalkthrough({
  document,
  dismiss: () => postMessage(DESKTOP_ONBOARDING_COMMANDS.DISMISS),
  setRoute,
});
appRoot.append(firstRunWalkthrough.element);

const commandPalette = createDesktopCommandPalette({
  document,
  canOpen: () => !firstRunWalkthrough.isVisible(),
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
      firstRunWalkthrough.show();
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
appRoot.append(commandPalette.element);
commandPaletteButton.addEventListener('click', commandPalette.open);
openWorkspaceButton.addEventListener('click', () =>
  postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
);

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
  // The shell template is rendered once at startup; aria-pressed/hidden are
  // mutated imperatively here. If a caller ever re-renders the shell, those
  // runtime mutations will be reset to the template defaults — convert this
  // function to update module-level route state and trigger a shell re-render
  // before doing that.
  for (const [candidate, container] of routeContainers) {
    container.hidden = candidate !== route;
  }
  for (const [candidate, button] of routeButtons) {
    button.setAttribute('aria-pressed', candidate === route ? 'true' : 'false');
  }
  document.body.dataset.desktopRoute = route;
  if (route === 'logs') requestLogSnapshot();
}

window.addEventListener('message', (event) => {
  if (isDesktopSetRouteMessage(event.data)) {
    setRoute(event.data.route);
  } else if (isDesktopOnboardingSetStateMessage(event.data)) {
    if (event.data.shouldShow) {
      firstRunWalkthrough.show();
    } else {
      firstRunWalkthrough.hide();
    }
  } else if (isThemeMessage(event.data)) {
    applyDesktopTheme(event.data.theme);
  } else if (isWorkspaceTreeMessage(event.data)) {
    renderWorkspaceExplorer(event.data);
  } else if (isDesktopSetLogMessage(event.data)) {
    renderLogSnapshot(event.data);
  }
});
requestWorkspaceTree();
postMessage(DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE);

function applyDesktopTheme(theme: DesktopThemeKind): void {
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
      actions: [
        {
          label: 'Open Folder',
          appearance: 'filled',
          variant: 'brand',
          onClick: () =>
            postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
        },
        {
          label: 'Logs',
          appearance: 'outlined',
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

function renderLogViewer(target: HTMLElement | undefined): void {
  if (target == null) return;
  render(logViewerTemplate(logViewerState), target);
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
  renderLogViewer(routeContainers.get('logs'));
}

function isWorkspaceTreeMessage(
  message: unknown,
): message is DesktopWorkspaceTreeMessage {
  return DesktopWorkspaceTreeMessageSchema.safeParse(message).success;
}

function requestWorkspaceTree(): void {
  if (!hasWorkspace) {
    renderWorkspaceExplorerNoWorkspace();
    return;
  }
  postMessage(DESKTOP_WORKSPACE_EXPLORER_COMMANDS.REQUEST_TREE);
}

type ExplorerState =
  | { kind: 'loading'; title: string }
  | { kind: 'no-workspace' }
  | { kind: 'tree'; title: string; tree: readonly WorkspaceTreeNode[] };

let explorerState: ExplorerState = { kind: 'loading', title: 'Workspace' };

function renderWorkspaceExplorerLoading(): void {
  const title = 'title' in explorerState ? explorerState.title : 'Workspace';
  explorerState = { kind: 'loading', title };
  renderExplorer();
}

function renderWorkspaceExplorerNoWorkspace(): void {
  explorerState = { kind: 'no-workspace' };
  renderExplorer();
}

function renderWorkspaceExplorer(message: DesktopWorkspaceTreeMessage): void {
  explorerState = {
    kind: 'tree',
    title: message.workspaceName ?? 'Workspace',
    tree: message.tree,
  };
  renderExplorer();
}

function renderExplorer(): void {
  render(explorerTemplate(), workspaceExplorerContainer);
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
    <div class="desktop-explorer-tree" role="tree">
      ${treeNodesTemplate(explorerState.tree, 0)}
    </div>
    <section class="desktop-explorer-selection" aria-live="polite">
      ${selectionPanelTemplate(explorerState.tree)}
    </section>
  `;
}

function explorerNoWorkspaceTemplate(): TemplateResult {
  return renderEmptyState({
    className: 'desktop-explorer-empty',
    icon: 'folder-open',
    title: 'No workspace',
    body: 'Open a folder before selecting files for agents.',
    actions: [
      {
        label: 'Open Folder',
        appearance: 'filled',
        variant: 'brand',
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
      <details
        class="desktop-explorer-directory"
        ?open=${depth < 2}
        style=${`--tree-depth: ${depth}`}
      >
        <summary
          class="desktop-explorer-row desktop-explorer-folder-row"
          role="treeitem"
        >
          ${waIcon('chevron-right', { className: 'desktop-explorer-chevron' })}
          ${waIcon('folder')}
          <span class="desktop-explorer-name">${node.name}</span>
        </summary>
        <div role="group">
          ${treeNodesTemplate(node.children ?? [], depth + 1)}
        </div>
      </details>
    `;
  }
  return html`
    <button
      class="desktop-explorer-row desktop-explorer-file-row"
      type="button"
      role="treeitem"
      title=${node.path}
      data-file-path=${node.path}
      data-selected=${selectedExplorerFile === node.path}
      style=${`--tree-depth: ${depth}`}
      @click=${() => selectExplorerFile(node.path)}
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
    </button>
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
  renderExplorer();
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
