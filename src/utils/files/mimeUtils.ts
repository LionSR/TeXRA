// Third-party imports
// Third-party imports
import mime from 'mime-types';

/**
 * Determine the MIME type for a file path or extension.
 * Returns null when the type cannot be resolved.
 */
export function getMimeType(filePath: string): string | null {
  const mimeType = mime.lookup(filePath);
  return typeof mimeType === 'string' ? mimeType : null;
}
