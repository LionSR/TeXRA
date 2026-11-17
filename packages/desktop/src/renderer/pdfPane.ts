// Compiled PDFs as workbench tabs: one `<iframe>` per open PDF, kept mounted
// across tab switches like the editor and terminal surfaces, so the viewer's
// scroll position and zoom survive a layout change. A bar above the frame
// opens the file in the system's viewer; a file that fails to load replaces
// the frame with its reason, which the main process reports.

import { html, nothing, render } from 'lit';

import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderEmptyState } from '@ui/wa/emptyState';
import {
  OPEN_EXTERNALLY_LABEL,
  PDF_LOAD_FAILED_TITLE,
} from '@ui/copy/hostViews';
import type { WorkbenchTab } from '../shared/desktopShellState';

interface PdfView {
  readonly host: HTMLElement;
  readonly frame: HTMLIFrameElement;
  /** Why the frame's file did not load, until it loads again. */
  failure: string | undefined;
}

export function createPdfPane(options: {
  /** Opens the PDF at `pdfUrl` in the system's viewer. */
  openExternally(pdfUrl: string): void;
}) {
  const views = new Map<string, PdfView>();

  function paint(view: PdfView): void {
    const url = view.frame.src;
    view.frame.hidden = view.failure !== undefined;
    render(
      html`
        <div class="shell-workbench-pdf-bar">
          ${renderLabeledActionButton({
            icon: 'arrow-up-right-from-square',
            text: OPEN_EXTERNALLY_LABEL,
            kind: 'secondary',
            onClick: () => options.openExternally(url),
          })}
        </div>
        ${
          view.failure === undefined
            ? nothing
            : renderEmptyState({
                icon: 'triangle-exclamation',
                title: PDF_LOAD_FAILED_TITLE,
                body: view.failure,
                className: 'shell-workbench-pdf-failure',
              })
        }
      `,
      view.host,
      // The frame is a sibling the template must not own: re-rendering
      // would otherwise reload it.
      { renderBefore: view.frame },
    );
  }

  /** The surface for a `pdf` tab, created on first render of that tab and
   *  reloaded when the tab names another build: a rebuild keeps the URL. */
  function viewFor(tab: WorkbenchTab): HTMLElement {
    const build = String(tab.build);
    const existing = views.get(tab.id);
    if (existing) {
      if (existing.frame.dataset.build !== build) {
        existing.frame.dataset.build = build;
        existing.frame.src = tab.target ?? '';
        existing.failure = undefined;
        paint(existing);
      }
      return existing.host;
    }
    const host = document.createElement('div');
    host.classList.add('shell-workbench-pdf');
    // An `<iframe>`, not `<webview>`: `<webview>` needs `webviewTag: true`
    // in webPreferences, which the window does not enable. Electron's main
    // BrowserWindow renders PDFs in iframes through the bundled Chromium
    // PDF plugin with no flag.
    const frame = document.createElement('iframe');
    frame.classList.add('shell-workbench-pdf-frame');
    frame.setAttribute('title', tab.title);
    // No `sandbox`: Chromium never loads its PDF viewer into a sandboxed
    // frame (the load fails with ERR_BLOCKED_BY_CLIENT), and no sandbox token
    // allows it. The frame only ever holds a `file:` URL of a `.pdf`
    // (`DesktopShowPdfMessageSchema`), which Chromium hands to the viewer,
    // whose own page runs in its own process, so no document of the PDF's
    // reaches this renderer.
    frame.dataset.build = build;
    frame.src = tab.target ?? '';
    host.append(frame);
    const view: PdfView = { host, frame, failure: undefined };
    views.set(tab.id, view);
    paint(view);
    return host;
  }

  /** Every tab showing `pdfUrl` shows `reason` in place of its frame. */
  function reportFailed(pdfUrl: string, reason: string): void {
    for (const view of views.values()) {
      if (view.frame.src !== pdfUrl) continue;
      view.failure = reason;
      paint(view);
    }
  }

  function dispose(tabId: string): void {
    const view = views.get(tabId);
    if (!view) return;
    view.frame.removeAttribute('src');
    views.delete(tabId);
  }

  return { viewFor, reportFailed, dispose };
}
