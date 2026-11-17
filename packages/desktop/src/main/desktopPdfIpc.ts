import { fileURLToPath } from 'node:url';
import { Result, Schema, type Effect } from 'effect';

import {
  DESKTOP_PDF_COMMANDS,
  DesktopOpenPdfExternallyMessageSchema,
  PdfFileUrlSchema,
} from '../shared/desktopPdfMessages.js';
import type { WebContents } from 'electron';
import { pdfLoadFailureText } from '@ui/copy/hostViews';
import type { DesktopPush } from '../shared/desktopOutboundMessages.js';
import type { PreviewUnavailable } from './desktopPreviewHost.js';
import { parsedRoute, type DesktopCommandRoutes } from './desktopIpcTypes.js';

/** Chromium's net error for a load that a newer one replaced, as a rebuild's
 *  reload does: not a failure of the file. */
const ERR_ABORTED = -3;

/**
 * The PDF tabs' half of the window. A frame that fails to load its file
 * (deleted, moved, unreadable) shows Chromium's own error page, which the
 * renderer cannot read across origins, so the failure is told from here,
 * where the window's frames report it. "Open externally" opens the tab's file
 * in the system's viewer; a failure reaches the window's router.
 */
export function createDesktopPdfIpc(
  post: (message: DesktopPush) => void,
  options: {
    webContents: WebContents;
    openPath(filePath: string): Effect.Effect<void, PreviewUnavailable>;
  },
): DesktopCommandRoutes {
  options.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame || errorCode === ERR_ABORTED) return;
      // Only a PDF's frame is this module's; another subframe's failure is
      // not a PDF tab's.
      const pdfUrl = Schema.decodeUnknownResult(PdfFileUrlSchema)(validatedURL);
      if (Result.isFailure(pdfUrl)) return;
      post({
        command: DESKTOP_PDF_COMMANDS.PDF_LOAD_FAILED,
        pdfUrl: pdfUrl.success,
        reason: pdfLoadFailureText(
          fileURLToPath(pdfUrl.success),
          errorCode,
          errorDescription,
        ),
      });
    },
  );
  return {
    [DESKTOP_PDF_COMMANDS.OPEN_PDF_EXTERNALLY]: parsedRoute(
      DesktopOpenPdfExternallyMessageSchema,
      (message) => options.openPath(fileURLToPath(message.pdfUrl)),
    ),
  };
}
