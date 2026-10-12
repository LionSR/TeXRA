// Browser-reachable (the progress webview imports it): no Node built-ins and
// no `@utils/core/pathCore`, which pulls in `node:path`.

/**
 * LaTeX file extensions that can be compiled to PDF.
 */
const LATEX_EXTENSIONS = ['.tex', '.ltx', '.latex'] as const;

// Like `path.extname`: a basename that is only the extension (`.tex`) is a
// dotfile with no extension.
function hasExtension(filePath: string, extension: string): boolean {
  const name = filePath.slice(filePath.search(/[^/\\]*$/)).toLowerCase();
  return name.length > extension.length && name.endsWith(extension);
}

/**
 * Returns true if the file has a .tex extension.
 */
export function isTexFile(filePath: string): boolean {
  return hasExtension(filePath, '.tex');
}

/**
 * Returns true if the file has a LaTeX extension (.tex, .ltx, .latex).
 * Use this for features that should work with all LaTeX document types.
 */
export function isLatexFile(filePath: string): boolean {
  return LATEX_EXTENSIONS.some((ext) => hasExtension(filePath, ext));
}
