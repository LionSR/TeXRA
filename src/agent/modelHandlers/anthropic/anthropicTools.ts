// Third-party imports
import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/messages';

/** Supported image media types from SDK's Base64ImageSource definition */
const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function isSupportedImageMediaType(
  mediaType: string,
): mediaType is Base64ImageSource['media_type'] {
  return SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType);
}
