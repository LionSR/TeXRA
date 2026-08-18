/** Descriptive filename generation for chat exports. */

import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';
import { isoDateOnly } from '@utils/text/stringUtils';

/**
 * Minimal fields these generators read. `ChatExportInput` satisfies this
 * structurally, so callers pass either the full input or an ad-hoc object of
 * the same shape without building a whole `ChatExportInput` for a filename.
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
  const parts = ['texra-chat', isoDateOnly(new Date(input.timestamp))];

  if (input.config.agent) {
    parts.push(sanitizeFilename(input.config.agent));
  }
  if (input.config.model) {
    const shortModel = input.config.model
      .replace(/[-_]\d+[-_]\d+.*$/, '')
      .replace(/[-_]\d{8}$/, '');
    parts.push(sanitizeFilename(shortModel));
  }

  return `${parts.join('-')}.${extension}`;
}

function sanitizeFilename(name: string): string {
  return sanitizePathSegment(name, {
    lowercase: true,
    invalidCharPattern: /[^a-z0-9-]/g,
    replacement: '-',
    collapseRepeats: true,
    trimReplacement: true,
  });
}
