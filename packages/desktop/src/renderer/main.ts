import './styles.css';
import './themeTokens.css';
import './codiconStylesheet';

import { COMMON_COMMANDS } from '@common/webview/commands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { postMessage } from '@shared/hostBridge';
import {
  SetThemeMessageSchema,
  type Theme,
} from '@shared/schemas/commonViewMessages';
import '@vscode-elements/elements/dist/bundled.js';
import '@progressView/frontend';
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
import {
  createDesktopCommandPalette,
  isCommandPaletteShortcut,
} from './desktopCommandPalette';

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

appRoot.innerHTML = `
  <section class="desktop-shell">
    <nav class="desktop-nav" aria-label="Desktop views">
      <button class="desktop-nav-button" type="button" data-route-button="main" aria-pressed="true">
        Launcher
      </button>
      <button class="desktop-nav-button" type="button" data-route-button="progress" aria-pressed="false">
        Progress
      </button>
      <button class="desktop-nav-button" type="button" data-route-button="settings" aria-pressed="false">
        Settings
      </button>
      <button class="desktop-nav-button" type="button" data-route-button="logs" aria-pressed="false">
        Logs
      </button>
      <button class="desktop-command-button" type="button" data-command-palette-button aria-haspopup="dialog">
        Commands
      </button>
      <button class="desktop-folder-button" type="button" data-open-workspace-button>
        Open Folder
      </button>
    </nav>
    <div class="desktop-workbench">
      <aside class="desktop-explorer" id="desktop-explorer" aria-label="Workspace Explorer"></aside>
      <main class="desktop-view" id="desktop-view">
        <section class="desktop-route" data-route="main"></section>
        <section class="desktop-route" data-route="progress" hidden></section>
        <section class="desktop-route" data-route="settings" hidden></section>
        <section class="desktop-route" data-route="logs" hidden></section>
      </main>
    </div>
  </section>
`;

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

const routeButtons = new Map<DesktopRoute, HTMLButtonElement>();
for (const route of DESKTOP_ROUTES) {
  const button = appRoot.querySelector<HTMLButtonElement>(
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
let currentExplorerTree: WorkspaceTreeNode[] = [];

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
routeContainers.get('logs')?.replaceChildren(createLogViewer());

const commandPaletteButton = appRoot.querySelector<HTMLButtonElement>(
  '[data-command-palette-button]',
);
if (commandPaletteButton == null) {
  throw new Error('TeXRA desktop command palette button was not found.');
}

const openWorkspaceButton = appRoot.querySelector<HTMLButtonElement>(
  '[data-open-workspace-button]',
);
if (openWorkspaceButton == null) {
  throw new Error('TeXRA desktop open workspace button was not found.');
}

const firstRunWalkthrough = createFirstRunWalkthrough();
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

function setRoute(route: DesktopRoute): void {
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
  } else if (isDesktopSetThemeMessage(event.data)) {
    applyDesktopTheme(event.data.theme);
  } else if (isWorkspaceTreeMessage(event.data)) {
    renderWorkspaceExplorer(event.data);
  } else if (isDesktopSetLogMessage(event.data)) {
    renderLogSnapshot(event.data);
  }
});
requestWorkspaceTree();
postMessage(DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE);

function isDesktopSetThemeMessage(
  message: unknown,
): message is { theme: Theme } {
  return (
    (message as { command?: unknown } | null)?.command ===
      COMMON_COMMANDS.THEME_SET &&
    SetThemeMessageSchema.safeParse(message).success
  );
}

function applyDesktopTheme(theme: Theme): void {
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

function createNoWorkspacePlaceholder(kind: 'launcher' | 'progress'): Element {
  const container = document.createElement('section');
  container.className = 'desktop-empty-workspace';
  const title =
    kind === 'launcher'
      ? 'Open a folder to use the launcher'
      : 'Open a folder to view workspace progress';
  const body =
    kind === 'launcher'
      ? 'TeXRA desktop needs a workspace before it can discover files, run agents, and place outputs.'
      : 'Progress details are tied to workspace runs. Start from a workspace to restore and follow sessions here.';

  container.innerHTML = `
    <div class="desktop-empty-workspace-panel">
      <span class="codicon codicon-folder-opened desktop-empty-workspace-icon" aria-hidden="true"></span>
      <h1>${title}</h1>
      <p>${body}</p>
      <div class="desktop-empty-workspace-actions">
        <button class="desktop-primary-button" type="button" data-empty-open-folder>
          Open Folder
        </button>
        <button class="desktop-secondary-button" type="button" data-empty-open-logs>
          Logs
        </button>
      </div>
    </div>
  `;
  container
    .querySelector<HTMLButtonElement>('[data-empty-open-folder]')
    ?.addEventListener('click', () =>
      postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
    );
  container
    .querySelector<HTMLButtonElement>('[data-empty-open-logs]')
    ?.addEventListener('click', () =>
      postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER),
    );
  return container;
}

function createFirstRunWalkthrough(): {
  element: HTMLElement;
  isVisible(): boolean;
  show(): void;
  hide(): void;
} {
  const element = document.createElement('section');
  element.className = 'desktop-onboarding';
  element.hidden = true;
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'true');
  element.setAttribute('aria-labelledby', 'desktop-onboarding-title');
  element.innerHTML = `
    <div class="desktop-onboarding-panel">
      <header class="desktop-onboarding-header">
        <span class="codicon codicon-info desktop-onboarding-icon" aria-hidden="true"></span>
        <div>
          <h1 id="desktop-onboarding-title">Welcome to TeXRA Desktop</h1>
          <p>Start from a workspace, configure model access, choose an agent, and run without switching to VS Code.</p>
        </div>
      </header>
      <ol class="desktop-onboarding-steps">
        <li>
          <span class="desktop-onboarding-step-index">1</span>
          <div>
            <strong>Open a workspace</strong>
            <span>Pick the folder that contains the paper or project files.</span>
          </div>
        </li>
        <li>
          <span class="desktop-onboarding-step-index">2</span>
          <div>
            <strong>Set up model access</strong>
            <span>Sign in for included access or add provider keys in Settings.</span>
          </div>
        </li>
        <li>
          <span class="desktop-onboarding-step-index">3</span>
          <div>
            <strong>Choose an agent</strong>
            <span>Select a workflow agent, direct agent, or tool-use agent.</span>
          </div>
        </li>
        <li>
          <span class="desktop-onboarding-step-index">4</span>
          <div>
            <strong>Start a run</strong>
            <span>Use the launcher and follow live output in Progress.</span>
          </div>
        </li>
      </ol>
      <footer class="desktop-onboarding-actions">
        <button class="desktop-secondary-button" type="button" data-onboarding-settings>
          Open Settings
        </button>
        <button class="desktop-secondary-button" type="button" data-onboarding-launcher>
          Go to Launcher
        </button>
        <button class="desktop-primary-button" type="button" data-onboarding-dismiss>
          Got it
        </button>
      </footer>
    </div>
  `;
  let previousFocus: HTMLElement | null = null;

  const getFocusableElements = (): HTMLElement[] =>
    [
      ...element.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (candidate) =>
        !candidate.hasAttribute('disabled') &&
        candidate.getAttribute('aria-hidden') !== 'true',
    );

  const hide = (): void => {
    const restoreFocus = previousFocus;
    element.hidden = true;
    previousFocus = null;
    restoreFocus?.focus();
  };
  const focusFirstControl = (): void => {
    const dismissButton = element.querySelector<HTMLButtonElement>(
      '[data-onboarding-dismiss]',
    );
    (dismissButton ?? getFocusableElements()[0])?.focus();
  };
  const show = (): void => {
    if (element.hidden) {
      previousFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    element.hidden = false;
    focusFirstControl();
  };
  const dismiss = (): void => {
    hide();
    postMessage(DESKTOP_ONBOARDING_COMMANDS.DISMISS);
  };
  const dismissAndShowRoute = (route: DesktopRoute): void => {
    dismiss();
    setRoute(route);
  };
  const onClick = (selector: string, handler: () => void): void => {
    element
      .querySelector<HTMLButtonElement>(selector)
      ?.addEventListener('click', handler);
  };

  onClick('[data-onboarding-settings]', () => dismissAndShowRoute('settings'));
  onClick('[data-onboarding-launcher]', () => dismissAndShowRoute('main'));
  onClick('[data-onboarding-dismiss]', dismiss);
  document.addEventListener('focusin', (event) => {
    if (element.hidden) return;
    if (event.target instanceof Node && element.contains(event.target)) return;
    focusFirstControl();
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (element.hidden) return;
      if (isCommandPaletteShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const focusedIndex = focusable.indexOf(
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : focusable[0],
      );
      const currentIndex = focusedIndex === -1 ? 0 : focusedIndex;
      const nextIndex = event.shiftKey
        ? (currentIndex - 1 + focusable.length) % focusable.length
        : (currentIndex + 1) % focusable.length;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    },
    true,
  );

  return { element, isVisible: () => !element.hidden, show, hide };
}

function createLogViewer(): HTMLElement {
  const container = document.createElement('section');
  container.className = 'desktop-log-viewer';
  container.innerHTML = `
    <header class="desktop-log-viewer-header">
      <div>
        <h2>Desktop Logs</h2>
        <p data-log-meta>Recent redacted log entries appear here.</p>
      </div>
      <div class="desktop-log-viewer-actions">
        <button class="desktop-secondary-button" type="button" data-log-refresh>Refresh</button>
        <button class="desktop-secondary-button" type="button" data-log-copy>Copy</button>
        <button class="desktop-secondary-button" type="button" data-log-export>Export</button>
        <button class="desktop-secondary-button" type="button" data-log-folder>Open Folder</button>
      </div>
    </header>
    <pre class="desktop-log-viewer-output" data-log-output>Open Logs to load recent entries.</pre>
  `;
  container
    .querySelector<HTMLButtonElement>('[data-log-refresh]')
    ?.addEventListener('click', requestLogSnapshot);
  container
    .querySelector<HTMLButtonElement>('[data-log-copy]')
    ?.addEventListener('click', () =>
      postMessage(DESKTOP_LOG_COMMANDS.COPY_LOG),
    );
  container
    .querySelector<HTMLButtonElement>('[data-log-export]')
    ?.addEventListener('click', () =>
      postMessage(DESKTOP_LOG_COMMANDS.EXPORT_LOG),
    );
  container
    .querySelector<HTMLButtonElement>('[data-log-folder]')
    ?.addEventListener('click', () =>
      postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER),
    );
  return container;
}

function requestLogSnapshot(): void {
  postMessage(DESKTOP_LOG_COMMANDS.REQUEST_LOG);
}

function renderLogSnapshot(message: DesktopSetLogMessage): void {
  const container = routeContainers.get('logs');
  const output = container?.querySelector<HTMLElement>('[data-log-output]');
  const meta = container?.querySelector<HTMLElement>('[data-log-meta]');
  if (output == null || meta == null) return;

  output.textContent = message.log.text || 'No desktop log entries yet.';
  const path = message.log.path ?? 'desktop log file';
  meta.textContent = message.log.truncated
    ? `Showing the most recent redacted entries from ${path}.`
    : `Showing redacted entries from ${path}.`;
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

function renderWorkspaceExplorerLoading(): void {
  workspaceExplorerContainer.replaceChildren();
  workspaceExplorerContainer.append(
    createExplorerHeader('Workspace', true),
    createExplorerStatus('Loading workspace files...'),
  );
}

function renderWorkspaceExplorerNoWorkspace(): void {
  workspaceExplorerContainer.replaceChildren();
  const prompt = document.createElement('section');
  prompt.className = 'desktop-explorer-empty';
  prompt.innerHTML = `
    <span class="codicon codicon-folder-opened" aria-hidden="true"></span>
    <h2>No workspace</h2>
    <p>Open a folder before selecting files for agents.</p>
    <button class="desktop-primary-button" type="button" data-explorer-open-folder>
      Open Folder
    </button>
  `;
  prompt
    .querySelector<HTMLButtonElement>('[data-explorer-open-folder]')
    ?.addEventListener('click', () =>
      postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
    );
  workspaceExplorerContainer.append(prompt);
}

function renderWorkspaceExplorer(message: DesktopWorkspaceTreeMessage): void {
  currentExplorerTree = message.tree;
  workspaceExplorerContainer.replaceChildren();
  workspaceExplorerContainer.append(
    createExplorerHeader(message.workspaceName ?? 'Workspace'),
  );

  if (message.tree.length === 0) {
    workspaceExplorerContainer.append(
      createExplorerStatus('No selectable workspace files found.'),
    );
    return;
  }

  const tree = document.createElement('div');
  tree.className = 'desktop-explorer-tree';
  tree.setAttribute('role', 'tree');
  renderTreeNodes(tree, message.tree, 0);

  const selection = document.createElement('section');
  selection.className = 'desktop-explorer-selection';
  selection.setAttribute('aria-live', 'polite');
  selection.dataset.selectionPanel = 'true';

  workspaceExplorerContainer.append(tree, selection);
  updateExplorerSelectionPanel(message.tree);
}

function createExplorerHeader(title: string, loading = false): HTMLElement {
  const header = document.createElement('header');
  header.className = 'desktop-explorer-header';
  const label = document.createElement('span');
  label.className = 'desktop-explorer-title';
  label.textContent = title;
  const refresh = document.createElement('button');
  refresh.className = 'desktop-explorer-icon-button codicon codicon-refresh';
  refresh.type = 'button';
  refresh.title = 'Refresh workspace files';
  refresh.setAttribute('aria-label', 'Refresh workspace files');
  refresh.disabled = loading || !hasWorkspace;
  refresh.addEventListener('click', requestWorkspaceTree);
  header.append(label, refresh);
  return header;
}

function createExplorerStatus(text: string): HTMLElement {
  const status = document.createElement('p');
  status.className = 'desktop-explorer-status';
  status.textContent = text;
  return status;
}

function renderTreeNodes(
  container: HTMLElement,
  nodes: readonly WorkspaceTreeNode[],
  depth: number,
): void {
  for (const node of nodes) {
    if (node.type === 'directory') {
      const details = document.createElement('details');
      details.className = 'desktop-explorer-directory';
      details.open = depth < 2;
      details.style.setProperty('--tree-depth', String(depth));

      const summary = document.createElement('summary');
      summary.className = 'desktop-explorer-row desktop-explorer-folder-row';
      summary.setAttribute('role', 'treeitem');
      summary.innerHTML = `
        <span class="codicon codicon-chevron-right desktop-explorer-chevron" aria-hidden="true"></span>
        <span class="codicon codicon-folder" aria-hidden="true"></span>
        <span class="desktop-explorer-name"></span>
      `;
      summary.querySelector('.desktop-explorer-name')!.textContent = node.name;
      details.append(summary);

      const group = document.createElement('div');
      group.setAttribute('role', 'group');
      renderTreeNodes(group, node.children ?? [], depth + 1);
      details.append(group);
      container.append(details);
      continue;
    }

    const row = document.createElement('button');
    row.className = 'desktop-explorer-row desktop-explorer-file-row';
    row.type = 'button';
    row.dataset.filePath = node.path;
    row.style.setProperty('--tree-depth', String(depth));
    row.setAttribute('role', 'treeitem');
    row.title = node.path;
    row.innerHTML = `
      <span class="codicon codicon-file" aria-hidden="true"></span>
      <span class="desktop-explorer-name"></span>
      <span class="desktop-explorer-category-strip"></span>
    `;
    row.querySelector('.desktop-explorer-name')!.textContent = node.name;
    row
      .querySelector('.desktop-explorer-category-strip')
      ?.replaceChildren(...createCategoryDots(node.categories ?? []));
    row.addEventListener('click', () => selectExplorerFile(node.path));
    row.addEventListener('dblclick', () => openWorkspaceFile(node.path));
    container.append(row);
  }
}

function createCategoryDots(categories: readonly string[]): HTMLElement[] {
  return categories.map((category) => {
    const dot = document.createElement('span');
    dot.className = 'desktop-explorer-category-dot';
    dot.title = category;
    dot.dataset.category = category;
    return dot;
  });
}

function selectExplorerFile(filePath: string): void {
  selectedExplorerFile = filePath;
  for (const row of workspaceExplorerContainer.querySelectorAll<HTMLElement>(
    '.desktop-explorer-file-row',
  )) {
    row.dataset.selected = String(row.dataset.filePath === filePath);
  }
  updateExplorerSelectionPanel(currentExplorerTree);
}

function updateExplorerSelectionPanel(
  tree: readonly WorkspaceTreeNode[],
): void {
  const panel = workspaceExplorerContainer.querySelector<HTMLElement>(
    '[data-selection-panel]',
  );
  if (!panel) return;
  const node = selectedExplorerFile
    ? findFileNode(tree, selectedExplorerFile)
    : undefined;
  if (!node) {
    panel.textContent =
      'Select a file to open it or attach it to the launcher.';
    return;
  }

  panel.replaceChildren();
  const path = document.createElement('div');
  path.className = 'desktop-explorer-selected-path';
  path.textContent = node.path;
  const actions = document.createElement('div');
  actions.className = 'desktop-explorer-selection-actions';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'desktop-secondary-button';
  open.textContent = 'Open';
  open.addEventListener('click', () => openWorkspaceFile(node.path));
  actions.append(open);

  for (const category of node.categories ?? []) {
    const typedCategory = parseExplorerCategory(category);
    if (!typedCategory) continue;
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'desktop-secondary-button';
    select.textContent = `Use as ${typedCategory}`;
    select.addEventListener('click', () =>
      selectWorkspaceFile(typedCategory, node.path),
    );
    actions.append(select);
  }

  panel.append(path, actions);
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
