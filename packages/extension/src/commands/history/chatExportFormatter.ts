/**
 * Template-driven formatters for exporting chat conversations
 * as Markdown or LaTeX documents.
 *
 * Architecture (pandoc-style):
 *   raw messages → normalizeMessages() → ExportNode[] → FormatSpec → string
 *
 * Each output format is a FormatSpec: a header template, a footer string,
 * and a node-renderer table. Adding a new block type means adding one case
 * to assistantBlockToNode() and one entry per renderer table.
 *
 * This module is VS Code-free — all platform wiring lives in the caller.
 *
 * The implementation lives in `./chatExport/`; this file is the public entry
 * point so existing import paths keep working.
 */

import { renderDocument } from './chatExport/formatSpec';
import { latexSpec } from './chatExport/latexSpec';
import { markdownSpec } from './chatExport/markdownSpec';
import type { ChatExportInput } from './chatExport/schemas';

export type {
  ChatExportInput,
  DocumentMeta,
  ExportNode,
} from './chatExport/schemas';
export type { FormatSpec } from './chatExport/formatSpec';
export { extractMeta } from './chatExport/formatSpec';
export { normalizeMessages } from './chatExport/normalizeMessages';
export {
  generateExportFilename,
  generateExportFolderName,
} from './chatExport/filenames';

export function formatChatAsMarkdown(input: ChatExportInput): string {
  return renderDocument(input, markdownSpec);
}

export function formatChatAsLatex(input: ChatExportInput): string {
  return renderDocument(input, latexSpec);
}
