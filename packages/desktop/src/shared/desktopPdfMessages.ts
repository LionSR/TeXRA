import { z } from 'zod';

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

export const DESKTOP_PDF_COMMANDS = {
  SHOW_PDF: 'desktop:showPdf',
} as const;

export const DesktopShowPdfMessageSchema = z.object({
  session: z.string().min(1),
  command: z.literal(DESKTOP_PDF_COMMANDS.SHOW_PDF),
  title: z.string(),
  pdfUrl: z
    .url({ protocol: /^file$/ })
    .refine((url) => new URL(url).pathname.toLowerCase().endsWith('.pdf'), {
      message: 'Not a PDF',
    }),
});

export type DesktopShowPdfMessage = z.infer<typeof DesktopShowPdfMessageSchema>;
