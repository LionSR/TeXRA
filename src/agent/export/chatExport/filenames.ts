/** Descriptive filename generation for chat exports. */

import { isoDateOnly } from '@utils/text/stringUtils';

/**
 * Minimal fields these generators read. `ChatExportInput` satisfies this
 * structurally; the trace-viewer HTML export (built from a `TraceDocument`,
 * not a `ChatExportInput`) passes an ad-hoc object of the same shape instead
 * of constructing a whole `ChatExportInput` just for a filename.
 */
export interface ExportFilenameInput {
  readonly timestamp: string;
  readonly config: { readonly agent?: string; readonly model?: string };
}

/**
 * Generate a descriptive filename for the export.
 * Example: `texra-chat-2026-03-05-research-claude-sonnet.md`
 */
export function generateExportFilename(
  input: ExportFilenameInput,
  extension: 'md' | 'tex' | 'html',
): string {
  return `${generateExportFolderName(input)}.${extension}`;
}

/**
 * Shared filename stem (no extension) used by single-file exports (md/tex/html).
 */
function generateExportFolderName(input: ExportFilenameInput): string {
  const date = new Date(input.timestamp);
  const datePart = isoDateOnly(date);

  const parts = ['texra-chat', datePart];

  if (input.config.agent) {
    parts.push(sanitizeFilename(input.config.agent));
  }
  if (input.config.model) {
    const shortModel = input.config.model
      .replace(/[-_]\d+[-_]\d+.*$/, '')
      .replace(/[-_]\d{8}$/, '');
    parts.push(sanitizeFilename(shortModel));
  }

  return parts.join('-');
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');
}
