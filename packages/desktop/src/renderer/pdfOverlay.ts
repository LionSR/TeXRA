import {
  isSafeAbsolutePdfPath,
  type DesktopShowPdfMessage,
} from '../shared/desktopPdfMessages';
import { createOverlayDialog } from './overlayDialog';
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

interface PdfOverlayElements {
  readonly dialog: WaDialog;
  readonly frame: HTMLIFrameElement;
  readonly titleEl: HTMLElement;
  readonly subtitleEl: HTMLElement;
}

export function createPdfOverlay(appRoot: HTMLElement): PdfOverlayController {
  let overlay: PdfOverlayElements | undefined;
  // Intent across the async hide animation: distinguishes a genuine close from
  // a reopen that lands while the previous close is still animating.
  let wantOpen = false;

  function ensure(): PdfOverlayElements {
    if (overlay) return overlay;
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

    const shell = createOverlayDialog({
      appRoot,
      prefix: 'desktop-pdf',
      ariaLabel: 'PDF preview',
      closeLabel: 'Close PDF preview',
      title: 'Preview',
      content: frame,
    });
    const d = shell.dialog;

    // `createOverlayDialog` already appended `d` to `appRoot` above, before
    // these listeners are registered. That's safe: `wa-dialog.open` defaults
    // to false and nothing before this point sets it, so `wa-hide`/
    // `wa-after-hide` (only dispatched from `requestClose()`, which requires
    // the dialog to already be showModal'd) cannot fire until `open()` below
    // sets `d.open = true`, which happens after this listener registration
    // has already returned.
    //
    // `wa-hide` fires for every close (close button, Escape, close()); open()
    // sets wantOpen back to true. wa-after-hide runs after the hide animation
    // — by which point a reopen during the animation has set a new src and
    // wantOpen=true. In that case re-assert the open state (the dialog already
    // flipped open=false internally as the close completed) so the new PDF
    // shows instead of getting wiped. Otherwise clear the src so the PDF isn't
    // resident across closes.
    d.addEventListener('wa-hide', () => {
      wantOpen = false;
    });
    d.addEventListener('wa-after-hide', () => {
      if (wantOpen) {
        d.open = true;
        return;
      }
      frame.removeAttribute('src');
    });

    overlay = {
      dialog: d,
      frame,
      titleEl: shell.titleEl,
      subtitleEl: shell.subtitleEl,
    };
    return overlay;
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
    const { dialog, frame, titleEl, subtitleEl } = ensure();
    titleEl.textContent = payload.title;
    subtitleEl.textContent = payload.pdfPath;
    frame.src = pdfPathToFileUrl(payload.pdfPath);
    wantOpen = true;
    dialog.open = true;
  }

  function close(): void {
    if (overlay) overlay.dialog.open = false;
  }

  return { open, close };
}
