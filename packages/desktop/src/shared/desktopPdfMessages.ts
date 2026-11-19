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
//     `pathToFileURL`. The schema accepts nothing else, so a malicious
//     main-process post can't turn the iframe into a generic browsing surface.
//   - `build`: the PDF's modification time in ms. A rebuild posts the same
//     URL, so this is what tells the open tab to reload.

//
// `desktop:pdfLoadFailed` reports a PDF frame the window could not load (a
// file deleted since its tab was opened or restored). The frame gives the
// renderer no failure event, so the main process, which hears it from
// Chromium, names the URL and the reason as a sentence.

export const DESKTOP_PDF_COMMANDS = Object.freeze({
  SHOW_PDF: 'desktop:showPdf',
  LOAD_FAILED: 'desktop:pdfLoadFailed',
} as const);

const PdfUrlSchema = Schema.String.check(
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
  pdfUrl: PdfUrlSchema,
  build: Schema.Number,
});

export const DesktopPdfLoadFailedMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_PDF_COMMANDS.LOAD_FAILED),
  pdfUrl: PdfUrlSchema,
  reason: Schema.String,
});
