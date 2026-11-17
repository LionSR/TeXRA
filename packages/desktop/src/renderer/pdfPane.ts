// Compiled PDFs as workbench tabs: one `<iframe>` per open PDF, kept mounted
// across tab switches like the editor and terminal surfaces, so the viewer's
// scroll position and zoom survive a layout change.

import '@awesome.me/webawesome/dist/components/callout/callout.js';
import { html, nothing, render } from 'lit';

import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';

import type { WorkbenchTab } from '../shared/desktopShellState';

interface PdfView {
  readonly element: HTMLElement;
  readonly frame: HTMLIFrameElement;
  readonly notice: HTMLElement;
}

/** The path a PDF's `file:` URL names. The main process built the URL from
 *  the path, so its pathname is the path, percent-encoded: a Windows drive
 *  path follows one extra slash, and a network share's server is the host. */
function filePathOf(url: string): string {
  const { hostname, pathname } = new URL(url);
  const path = decodeURIComponent(pathname);
  if (hostname) return `//${hostname}${path}`;
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

export function createPdfPane(options: {
  /** Hands the PDF at `path` to the OS's default application. The window
   *  shows a failure itself, so the pane hears nothing back. */
  openExternally(path: string): void;
}) {
  const views = new Map<string, PdfView>();

  /** Says why the PDF did not load, in place of the frame, which has nothing
   *  to show; `undefined` shows the frame again. */
  function report(view: PdfView, failure: string | undefined): void {
    view.frame.hidden = failure !== undefined;
    render(
      failure === undefined
        ? nothing
        : html`<wa-callout variant="danger" size="s" role="alert">
            ${waIcon('triangle-exclamation', { slot: 'icon' })}
            <span class="desktop-editor-notice-text">${failure}</span>
          </wa-callout>`,
      view.notice,
    );
  }

  function load(view: PdfView, tab: WorkbenchTab): void {
    report(view, undefined);
    view.frame.dataset.build = String(tab.build);
    view.frame.src = tab.target ?? '';
  }

  /** The pane for a `pdf` tab, created on first render of that tab and
   *  reloaded when the tab names another build: a rebuild keeps the URL. */
  function elementFor(tab: WorkbenchTab): HTMLElement {
    const existing = views.get(tab.id);
    if (existing) {
      if (existing.frame.dataset.build !== String(tab.build))
        load(existing, tab);
      return existing.element;
    }
    const element = document.createElement('div');
    element.className = 'shell-workbench-pdf';
    const notice = document.createElement('div');
    notice.className = 'desktop-editor-notice';
    // An `<iframe>`, not `<webview>`: `<webview>` needs `webviewTag: true`
    // in webPreferences, which the window does not enable.
    const frame = document.createElement('iframe');
    frame.classList.add('shell-workbench-pdf-frame');
    frame.setAttribute('title', tab.title);
    // No scripts, so a malformed PDF cannot run JS into the renderer. The
    // cost, measured on Electron 45 on Linux: Chromium does not start its PDF
    // viewer in a sandboxed frame and fails the load with
    // ERR_BLOCKED_BY_CLIENT, which this pane reports like any other failure.
    frame.setAttribute('sandbox', 'allow-same-origin');
    const view: PdfView = { element, frame, notice };
    const footer = document.createElement('footer');
    footer.className = 'shell-editor-toolbar';
    const path = filePathOf(tab.target ?? '');
    render(
      html`<span class="shell-editor-path" title=${path}>${path}</span>
        ${renderLabeledActionButton({
          text: 'Open externally',
          icon: 'arrow-up-right-from-square',
          kind: 'ghost',
          className: 'is-compact',
          onClick: () => options.openExternally(path),
        })}`,
      footer,
    );
    element.append(notice, frame, footer);
    views.set(tab.id, view);
    load(view, tab);
    return element;
  }

  return {
    elementFor,

    /** The window could not load the PDF at `pdfUrl`: every tab showing it
     *  says so in place of the viewer, until a rebuild reloads it. */
    reportLoadFailure(pdfUrl: string, reason: string): void {
      for (const view of views.values()) {
        if (view.frame.src === pdfUrl)
          report(view, `Couldn't load ${view.frame.title}. ${reason}`);
      }
    },

    dispose(tabId: string): void {
      const view = views.get(tabId);
      if (!view) return;
      view.frame.removeAttribute('src');
      views.delete(tabId);
    },
  };
}
