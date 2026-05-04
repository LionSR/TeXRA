import './styles.css';
import './themeTokens.css';

import '@progressView/frontend';
import '@settingsView/frontend';
import '@webview/frontend';

import {
  DesktopSetRouteMessageSchema,
  type DesktopRoute,
  type DesktopSetRouteMessage,
} from '../desktopShellMessages';

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

const mainApp = document.createElement('main-app');
mainApp.setAttribute('data-desktop-view', 'main');

const progressApp = document.createElement('progress-app');
progressApp.setAttribute('data-desktop-view', 'progress');

const settingsApp = document.createElement('settings-app');
settingsApp.setAttribute('data-desktop-view', 'settings');

routeContainers.get('main')?.replaceChildren(mainApp);
routeContainers.get('progress')?.replaceChildren(progressApp);
routeContainers.get('settings')?.replaceChildren(settingsApp);

function isDesktopSetRouteMessage(
  message: unknown,
): message is DesktopSetRouteMessage {
  return DesktopSetRouteMessageSchema.safeParse(message).success;
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
  }
});
