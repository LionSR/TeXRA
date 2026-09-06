import { z } from 'zod';

// IPC for the PDF workbench tab. `desktopPreviewHost.openBuildDisplay`
// compiles a TeX source (or takes a PDF as it is) and posts `desktop:showPdf`
// keyed by session; the renderer opens one `pdf` workbench tab per path
// (`workbenchController` + `pdfPane`, an `<iframe src="file://...">` on
// Electron's built-in Chromium viewer). The tab's close control is the
// tab strip's, so nothing posts a close.
//
// `desktop:showPdf` carries:
//   - `title`: the tab title (e.g. "paper.pdf")
//   - `pdfPath`: absolute filesystem path the renderer turns into a
//     `file://` URL. The renderer rejects payloads whose path doesn't
//     resolve to an absolute path so a malicious main-process post
//     can't trick the iframe into loading arbitrary URLs.

export const DESKTOP_PDF_COMMANDS = {
  SHOW_PDF: 'desktop:showPdf',
} as const;

export const DesktopShowPdfMessageSchema = z.object({
  session: z.string().min(1),
  command: z.literal(DESKTOP_PDF_COMMANDS.SHOW_PDF),
  title: z.string(),
  // Absolute path to the PDF on disk. The renderer prepends `file://`
  // and assigns it to an iframe src; see `isSafeAbsolutePdfPath` below
  // for the sanitization contract.
  pdfPath: z.string().min(1),
});

export type DesktopShowPdfMessage = z.infer<typeof DesktopShowPdfMessageSchema>;

// Sanitize the PDF path before rendering it in an iframe. The renderer
// must only accept absolute filesystem paths — anything that smells
// like a different URL scheme (`http:`, `javascript:`, `data:`, ...)
// is rejected to keep the tab from being abused as a generic
// browsing surface. Path traversal isn't a concern here because the
// renderer has no privileged paths it's hiding; the threat model is
// "main process posts something other than a PDF on disk".
//
// VS Code-free zone: pure string predicate, no `node:path` import so
// the renderer can call this without bundling node polyfills.
export function isSafeAbsolutePdfPath(pdfPath: string): boolean {
  // Strip wrapping whitespace — if anything non-trivial was trimmed
  // the path is probably crafted; reject conservatively. (An empty
  // string passes this check but is rejected by the shape checks below.)
  if (pdfPath.trim() !== pdfPath) return false;
  // Accept exactly three absolute-path shapes; everything else
  // (relative paths, URL schemes like `http:` / `javascript:` /
  // `data:` / even `file:`) falls through to `false`. The shape
  // checks alone reject URL schemes — they don't start with `/`,
  // `\\`, or a single ASCII drive letter immediately followed by a
  // path separator — so no separate scheme-rejection branch is
  // needed.
  //
  //   - Posix absolute: leading `/`
  //   - Windows drive-letter absolute: `C:\...` or `C:/...`
  //   - Windows UNC absolute: `\\server\share\...`
  const isPosixAbs = pdfPath.startsWith('/');
  const isWindowsDriveAbs = /^[A-Za-z]:[\\/]/.test(pdfPath);
  const isWindowsUncAbs = pdfPath.startsWith('\\\\');
  if (!(isPosixAbs || isWindowsDriveAbs || isWindowsUncAbs)) return false;
  // Must end in `.pdf` (case-insensitive). Belt-and-suspenders — the
  // main process only sends compiled PDFs today, but the renderer
  // shouldn't trust that exclusively.
  return /\.pdf$/i.test(pdfPath);
}
