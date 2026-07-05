/**
 * Template-driven formatters for exporting chat conversations
 * as Markdown, LaTeX, or HTML documents.
 *
 * Architecture (pandoc-style):
 *   raw messages → normalizeMessages() → ExportNode[] → FormatSpec → string
 *
 * Each output format is a FormatSpec: a header template, a footer string,
 * and a node-renderer table. Adding a new block type means adding one case
 * to assistantBlockToNode() and one entry per renderer table.
 *
 * This module is host-neutral — all platform wiring lives in the caller. The
 * LaTeX document preamble is a host-supplied string (the `.tex` template lives
 * under the extension's `resources/`), so it is passed into `formatChatAsLatex`
 * rather than imported here.
 *
 * The implementation lives in `./chatExport/` (Markdown/LaTeX) and
 * `./htmlExport/` (HTML); this file is the public entry point so callers
 * import a single stable surface.
 */

import type { ChatExportInput } from '@agent/export/schemas';
import { renderDocument } from './chatExport/formatSpec';
import { createLatexSpec } from './chatExport/latexSpec';
import { markdownSpec } from './chatExport/markdownSpec';

export type {
  ChatExportInput,
  DocumentMeta,
  ExportNode,
} from '@agent/export/schemas';
export type { FormatSpec } from './chatExport/formatSpec';
export { extractMeta } from './chatExport/formatSpec';
export { normalizeConversationForExport as normalizeMessages } from '@agent/export/normalizeConversation';
export {
  generateExportFilename,
  generateExportFolderName,
} from './chatExport/filenames';
export {
  formatChatAsHtml,
  DEFAULT_HTML_EXPORT_ASSETS_HREF,
  type HtmlExportOptions,
} from './htmlExport/htmlFormatter';

export function formatChatAsMarkdown(input: ChatExportInput): string {
  return renderDocument(input, markdownSpec);
}

export function formatChatAsLatex(
  input: ChatExportInput,
  latexPreamble: string,
): string {
  return renderDocument(input, createLatexSpec(latexPreamble));
}
