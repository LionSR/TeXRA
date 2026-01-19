// Third-party imports
import mime from 'mime-types';

/**
 * Determine the MIME type for a file path or extension.
 * Returns null when the type cannot be resolved.
 */
export function getMimeType(filePath: string): string | null {
  return mime.lookup(filePath) || null;
}
