/** Descriptive filename generation for chat exports. */

import type { ChatExportInput } from '@agent/export/schemas';
import { isoDateOnly } from '@utils/text/stringUtils';

/**
 * Generate a descriptive filename for the export.
 * Example: `texra-chat-2026-03-05-research-claude-sonnet.md`
 */
export function generateExportFilename(
  input: ChatExportInput,
  extension: 'md' | 'tex' | 'html',
): string {
  return `${generateExportFolderName(input)}.${extension}`;
}

/**
 * Shared filename stem (no extension) used by both single-file exports
 * (md/tex) and the HTML export's containing folder.
 */
export function generateExportFolderName(input: ChatExportInput): string {
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
