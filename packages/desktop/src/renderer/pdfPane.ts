// Compiled PDFs as workbench tabs: one `<iframe>` per open PDF, kept mounted
// across tab switches like the editor and terminal surfaces, so the viewer's
// scroll position and zoom survive a layout change.

import type { WorkbenchTab } from '../shared/desktopTaskShell';

/**
 * Convert an absolute filesystem path (already shape-validated by
 * `isSafeAbsolutePdfPath` at the message boundary) into a `file:` URL safe
 * for an iframe `src`.
 *
 * - posix `/abs/path.pdf` becomes `file:///abs/path.pdf`
 * - Windows drive `C:\path\file.pdf` becomes `file:///C:/path/file.pdf`
 * - Windows UNC `\\server\share\file.pdf` becomes `file://server/share/file.pdf`
 */
function pdfPathToFileUrl(absolutePath: string): string {
  const normalised = absolutePath.replaceAll('\\', '/');
  const encodePath = (path: string): string =>
    path.split('/').map(encodeURIComponent).join('/');
  if (normalised.startsWith('//')) {
    return `file://${encodePath(normalised.slice(2))}`;
  }
  if (normalised.startsWith('/')) {
    return `file:///${encodePath(normalised.slice(1))}`;
  }
  const driveMatch = normalised.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) {
    return `file:///${driveMatch[1]}:/${encodePath(driveMatch[2])}`;
  }
  return `file:///${encodeURIComponent(normalised)}`;
}

export function createPdfPane() {
  const frames = new Map<string, HTMLIFrameElement>();

  /** The frame for a `pdf` tab, created on first render of that tab. */
  function frameFor(tab: WorkbenchTab): HTMLIFrameElement {
    const existing = frames.get(tab.id);
    if (existing) return existing;
    // An `<iframe>`, not `<webview>`: `<webview>` needs `webviewTag: true`
    // in webPreferences, which the window does not enable. Electron's main
    // BrowserWindow renders PDFs in iframes through the bundled Chromium
    // PDF plugin with no flag.
    const frame = document.createElement('iframe');
    frame.classList.add('task-workbench-pdf-frame');
    frame.setAttribute('title', tab.title);
    // Same-origin so the viewer's controls work; no scripts, so a malformed
    // PDF cannot run JS into the renderer.
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.src = pdfPathToFileUrl(tab.target ?? '');
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
