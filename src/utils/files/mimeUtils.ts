// Third-party imports
import mime from 'mime-types';

const AUDIO_MIME_TYPE_OVERRIDES: Readonly<Record<string, string>> = {
  // mime-types does not expose every audio subtype accepted by current model SDKs.
  '.alaw': 'audio/alaw',
  '.l16': 'audio/l16',
  '.mulaw': 'audio/mulaw',
  '.opus': 'audio/opus',
};

function getExtension(pathOrExtension: string): string {
  const hasPathSeparator = /[\\/]/.test(pathOrExtension);
  const fileName = pathOrExtension.split(/[\\/]/).at(-1) ?? pathOrExtension;
  if (fileName.startsWith('.') && !fileName.slice(1).includes('.')) {
    return fileName.toLowerCase();
  }

  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex >= 0) {
    return fileName.slice(dotIndex).toLowerCase();
  }

  if (hasPathSeparator) {
    return '';
  }

  return `.${fileName.toLowerCase()}`;
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
