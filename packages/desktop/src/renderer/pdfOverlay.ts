import { render } from 'lit';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  isSafeAbsolutePdfPath,
  type DesktopShowPdfMessage,
} from '../desktopPdfMessages';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';

/**
 * Convert an absolute filesystem path (already shape-validated by
 * `isSafeAbsolutePdfPath`) into a `file:` URL safe for an iframe `src`.
 *
 * - posix `/abs/path.pdf` → `file:///abs/path.pdf`
 * - Windows drive `C:\path\file.pdf` → `file:///C:/path/file.pdf`
 * - Windows UNC `\\server\share\file.pdf` → `file://server/share/file.pdf`
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

export interface PdfOverlayController {
  open(payload: DesktopShowPdfMessage): void;
  close(): void;
}

export function createPdfOverlay(appRoot: HTMLElement): PdfOverlayController {
  let dialog: WaDialog | null = null;
  let frameEl: HTMLIFrameElement | null = null;
  let titleEl: HTMLElement | null = null;
  let subtitleEl: HTMLElement | null = null;

  function ensure(): WaDialog {
    if (dialog) return dialog;
    const d = document.createElement('wa-dialog') as WaDialog;
    d.classList.add('desktop-pdf-overlay');
    d.withoutHeader = true;
    d.lightDismiss = false;
    d.setAttribute('aria-label', 'PDF preview');

    const body = document.createElement('section');
    body.classList.add('desktop-pdf-body');

    const header = document.createElement('header');
    header.classList.add('desktop-pdf-header');
    const t = document.createElement('h2');
    t.classList.add('desktop-pdf-title');
    t.textContent = 'Preview';
    titleEl = t;
    const s = document.createElement('p');
    s.classList.add('desktop-pdf-subtitle');
    subtitleEl = s;
    header.append(t, s);

    // Use an `<iframe>` (not `<webview>`) — `<webview>` requires
    // `webviewTag: true` in webPreferences which we don't enable.
    // Electron's main BrowserWindow renders PDFs in iframes via the
    // bundled Chromium PDF plugin, no flag needed.
    const frame = document.createElement('iframe');
    frame.classList.add('desktop-pdf-frame');
    frame.setAttribute('title', 'PDF preview');
    // sandbox: allow same-origin so the PDF viewer's controls work; deny
    // scripts so a malformed PDF can't run JS into our renderer.
    frame.setAttribute('sandbox', 'allow-same-origin');
    frameEl = frame;

    body.append(header, frame);
    d.append(body);

    const close = document.createElement('wa-button');
    close.classList.add('desktop-pdf-close');
    close.setAttribute('appearance', 'plain');
    close.setAttribute('size', 'small');
    close.setAttribute('aria-label', 'Close PDF preview');
    close.setAttribute('title', 'Close PDF preview');
    render(waIcon('xmark'), close);
    close.addEventListener('click', () => {
      d.open = false;
    });
    d.append(close);

    // Clear the iframe src on hide so the PDF isn't resident across closes.
    d.addEventListener('wa-after-hide', () => {
      if (frameEl) frameEl.removeAttribute('src');
    });

    appRoot.append(d);
    dialog = d;
    return d;
  }

  function open(payload: DesktopShowPdfMessage): void {
    // Defense in depth: reject anything that smells like a non-`file:` URL
    // before assigning to `iframe.src` even though the schema parsed.
    if (!isSafeAbsolutePdfPath(payload.pdfPath)) {
      console.error(
        '[desktop] desktopPdfOverlay: rejected unsafe PDF path',
        payload.pdfPath,
      );
      return;
    }
    const d = ensure();
    if (titleEl) titleEl.textContent = payload.title;
    if (subtitleEl) subtitleEl.textContent = payload.pdfPath;
    if (frameEl) frameEl.src = pdfPathToFileUrl(payload.pdfPath);
    d.open = true;
  }

  function close(): void {
    if (dialog) dialog.open = false;
  }

  return { open, close };
}
