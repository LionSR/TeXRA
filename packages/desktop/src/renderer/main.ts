import './styles.css';
import './themeTokens.css';
import './codiconStylesheet';

import { COMMON_COMMANDS } from '@common/webview/commands';
import { postMessage } from '@shared/hostBridge';
import { SetThemeMessageSchema } from '@shared/schemas/commonViewMessages';
import '@vscode-elements/elements/dist/bundled.js';
import '@progressView/frontend';
import '@settingsView/frontend';
import '@webview/frontend';

import {
  DesktopSetRouteMessageSchema,
  type DesktopRoute,
  type DesktopSetRouteMessage,
} from '../desktopShellMessages';
import {
  buildDesktopSettingsTabMessage,
  DESKTOP_LOCAL_COMMANDS,
} from '../desktopCommandSurface';
import { createDesktopCommandPalette } from './desktopCommandPalette';

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
      <button class="desktop-command-button" type="button" data-command-palette-button aria-haspopup="dialog">
        Commands
      </button>
      <button class="desktop-log-button" type="button" data-open-log-button>
        Logs
      </button>
      <button class="desktop-folder-button" type="button" data-open-workspace-button>
        Open Folder
      </button>
    </nav>
    <main class="desktop-view" id="desktop-view">
      <section class="desktop-route" data-route="main"></section>
      <section class="desktop-route" data-route="progress" hidden></section>
      <section class="desktop-route" data-route="settings" hidden></section>
    </main>
  </section>
`;

const desktopViewContainer =
  appRoot.querySelector<HTMLElement>('#desktop-view');
if (desktopViewContainer == null) {
  throw new Error('TeXRA desktop view container was not found.');
}

const routeContainers = new Map<DesktopRoute, HTMLElement>();
for (const route of ['main', 'progress', 'settings'] as const) {
  const container = desktopViewContainer.querySelector<HTMLElement>(
    `[data-route="${route}"]`,
  );
  if (container == null) {
    throw new Error(`TeXRA desktop route container was not found: ${route}`);
  }
  routeContainers.set(route, container);
}

const routeButtons = new Map<DesktopRoute, HTMLButtonElement>();
for (const route of ['main', 'progress', 'settings'] as const) {
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

const openLogButton = appRoot.querySelector<HTMLButtonElement>(
  '[data-open-log-button]',
);
if (openLogButton == null) {
  throw new Error('TeXRA desktop open log button was not found.');
}

const commandPalette = createDesktopCommandPalette({
  document,
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
    openLogFolder: () => {
      postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER);
    },
    openWorkspaceFolder: () => {
      postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER);
    },
  },
});
appRoot.append(commandPalette.element);
commandPaletteButton.addEventListener('click', commandPalette.open);
openWorkspaceButton.addEventListener('click', () =>
  postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
);
openLogButton.addEventListener('click', () =>
  postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER),
);

function isDesktopSetRouteMessage(
  message: unknown,
): message is DesktopSetRouteMessage {
  return DesktopSetRouteMessageSchema.safeParse(message).success;
}

function isThemeMessage(
  message: unknown,
): message is { command: typeof COMMON_COMMANDS.THEME_SET; theme: string } {
  return SetThemeMessageSchema.safeParse(message).success;
}

function setRoute(route: DesktopRoute): void {
  for (const [candidate, container] of routeContainers) {
    container.hidden = candidate !== route;
  }
  for (const [candidate, button] of routeButtons) {
    button.setAttribute('aria-pressed', candidate === route ? 'true' : 'false');
  }
  document.body.dataset.desktopRoute = route;
}

window.addEventListener('message', (event) => {
  if (isDesktopSetRouteMessage(event.data)) {
    setRoute(event.data.route);
  } else if (isThemeMessage(event.data)) {
    applyDesktopTheme(event.data.theme);
  }
});

function applyDesktopTheme(theme: string): void {
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
