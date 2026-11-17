import { Schema } from 'effect';

// IPC for the PDF workbench tab. `desktopPreviewHost.openBuildDisplay`
// compiles a TeX source (or takes a PDF as it is) and posts `desktop:showPdf`
// keyed by session; the renderer opens one `pdf` workbench tab per URL
// (`workbenchController` + `pdfPane`, an `<iframe src="file://...">` on
// Electron's built-in Chromium viewer). The tab's close control is the
// tab strip's, so nothing posts a close.
//
// `desktop:showPdf` carries:
//   - `title`: the tab title (e.g. "paper.pdf")
//   - `pdfUrl`: the `file:` URL of the PDF, built by the main process with
//     `pathToFileURL`.
//   - `build`: the PDF's modification time in ms. A rebuild posts the same
//     URL, so this is what tells the open tab to reload.

export const DESKTOP_PDF_COMMANDS = {
  SHOW_PDF: 'desktop:showPdf',
  /** The main process: a PDF tab's frame failed to load its file. */
  PDF_LOAD_FAILED: 'desktop:pdf:loadFailed',
  /** The renderer: open a PDF tab's file in the system's PDF viewer. */
  OPEN_PDF_EXTERNALLY: 'desktop:pdf:openExternally',
} as const;

/** The `file:` URL of a PDF. The schema accepts nothing else, so a malicious
 *  post can neither turn the frame into a browsing surface nor have the main
 *  process open another kind of file. */
export const PdfFileUrlSchema = Schema.String.check(
  Schema.makeFilter(
    (url) => {
      const parsed = URL.parse(url);
      if (parsed === null || parsed.protocol !== 'file:')
        return 'Not a file: URL';
      return parsed.pathname.toLowerCase().endsWith('.pdf')
        ? undefined
        : 'Not a PDF';
    },
    { message: 'a file: URL of a PDF' },
  ),
);

export const DesktopShowPdfMessageSchema = Schema.Struct({
  session: Schema.NonEmptyString,
  command: Schema.Literal(DESKTOP_PDF_COMMANDS.SHOW_PDF),
  title: Schema.String,
  pdfUrl: PdfFileUrlSchema,
  build: Schema.Number,
});

/** Every PDF tab showing `pdfUrl`, in any project, shows `reason` instead of
 *  its frame until it loads again. */
export const DesktopPdfLoadFailedMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_PDF_COMMANDS.PDF_LOAD_FAILED),
  pdfUrl: PdfFileUrlSchema,
  reason: Schema.String,
});

export const DesktopOpenPdfExternallyMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_PDF_COMMANDS.OPEN_PDF_EXTERNALLY),
  pdfUrl: PdfFileUrlSchema,
});
