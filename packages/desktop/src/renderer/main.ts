import './styles.css';
import './themeTokens.css';

import '@webview/frontend';

const root = document.querySelector<HTMLElement>('#app');

if (root == null) {
  throw new Error('TeXRA desktop renderer root was not found.');
}

const appRoot = root;

appRoot.innerHTML = `
  <section class="desktop-shell">
    <main class="desktop-view" id="desktop-view"></main>
  </section>
`;

const desktopViewContainer =
  appRoot.querySelector<HTMLElement>('#desktop-view');
if (desktopViewContainer == null) {
  throw new Error('TeXRA desktop view container was not found.');
}

const mainApp = document.createElement('main-app');
mainApp.setAttribute('data-desktop-view', 'main');
desktopViewContainer.replaceChildren(mainApp);
