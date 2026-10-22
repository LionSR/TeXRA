// Compiled PDFs as workbench tabs: one `<iframe>` per open PDF, kept mounted
// across tab switches like the editor and terminal surfaces, so the viewer's
// scroll position and zoom survive a layout change.

import type { WorkbenchTab } from '../shared/desktopShellState';

export function createPdfPane() {
  const frames = new Map<string, HTMLIFrameElement>();

  /** The frame for a `pdf` tab, created on first render of that tab and
   *  reloaded when the tab names another build: a rebuild keeps the URL. */
  function frameFor(tab: WorkbenchTab): HTMLIFrameElement {
    const build = String(tab.build);
    const existing = frames.get(tab.id);
    if (existing) {
      if (existing.dataset.build !== build) {
        existing.dataset.build = build;
        existing.src = tab.target ?? '';
      }
      return existing;
    }
    // An `<iframe>`, not `<webview>`: `<webview>` needs `webviewTag: true`
    // in webPreferences, which the window does not enable. Electron's main
    // BrowserWindow renders PDFs in iframes through the bundled Chromium
    // PDF plugin with no flag.
    const frame = document.createElement('iframe');
    frame.classList.add('shell-workbench-pdf-frame');
    frame.setAttribute('title', tab.title);
    // Same-origin so the viewer's controls work; no scripts, so a malformed
    // PDF cannot run JS into the renderer.
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.dataset.build = build;
    frame.src = tab.target ?? '';
    frames.set(tab.id, frame);
    return frame;
  }

  function dispose(tabId: string): void {
    const frame = frames.get(tabId);
    if (!frame) return;
    frame.removeAttribute('src');
    frames.delete(tabId);
  }

  return { frameFor, dispose };
}
