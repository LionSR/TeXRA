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

export const DESKTOP_PDF_COMMANDS = {
  SHOW_PDF: 'desktop:showPdf',
} as const;

export const DesktopShowPdfMessageSchema = Schema.Struct({
  session: Schema.String.check(Schema.isMinLength(1)),
  command: Schema.Literal(DESKTOP_PDF_COMMANDS.SHOW_PDF),
  title: Schema.String,
  pdfUrl: Schema.String.check(
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
  ),
  build: Schema.Number,
});

export type DesktopShowPdfMessage = typeof DesktopShowPdfMessageSchema.Type;
