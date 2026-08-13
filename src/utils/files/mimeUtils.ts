// Standard library imports
import * as path from 'node:path';

// Third-party imports
import mime from 'mime-types';

import { normalizeFilePath } from '@utils/core';

const AUDIO_MIME_TYPE_OVERRIDES: Readonly<Record<string, string>> = {
  // mime-types does not expose every audio subtype accepted by current model SDKs.
  '.alaw': 'audio/alaw',
  '.l16': 'audio/l16',
  '.mulaw': 'audio/mulaw',
  '.opus': 'audio/opus',
};

/**
 * Accepts a full path, a dotfile name (`.opus`), or a bare extension (`opus`).
 * Returns the lowercase extension with a leading dot, or `''` for
 * extensionless paths that have a directory separator.
 */
function getExtension(pathOrExtension: string): string {
  const normalized = normalizeFilePath(pathOrExtension);
  const separatorIndex = normalized.lastIndexOf('/');
  const fileName = normalized.slice(separatorIndex + 1);

  // Dotfile with no further dot (e.g. `.opus`) — treat the whole name as the extension.
  if (fileName.startsWith('.') && !fileName.slice(1).includes('.')) {
    return fileName.toLowerCase();
  }

  const ext = path.extname(fileName);
  if (ext) return ext.toLowerCase();

  // Bare extension string like `opus` (no separator, no dot) → `.opus`.
  if (separatorIndex === -1) return `.${fileName.toLowerCase()}`;

  return '';
}

/**
 * Determine the MIME type for a file path or extension.
 * Returns null when the type cannot be resolved.
 */
export function getMimeType(filePath: string): string | null {
  const extension = getExtension(filePath);
  if (extension && Object.hasOwn(AUDIO_MIME_TYPE_OVERRIDES, extension)) {
    return AUDIO_MIME_TYPE_OVERRIDES[extension];
  }

  return mime.lookup(filePath) || null;
}

/** File extensions for binary office document formats (case-insensitive, with leading dot). */
export const OFFICE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Word processing
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  // Spreadsheets
  '.xls',
  '.xlsx',
  '.ods',
  // Presentations
  '.ppt',
  '.pptx',
  '.odp',
  // Apple iWork
  '.pages',
  '.numbers',
  '.key',
]);

/** MIME types for binary office document formats. */
export const OFFICE_MIME_TYPES: ReadonlySet<string> = new Set([
  // Word processing
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/rtf',
  // Spreadsheets
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  // Presentations
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
  // Apple iWork
  'application/vnd.apple.pages',
  'application/vnd.apple.numbers',
  'application/vnd.apple.keynote',
]);
