import { imageSize } from 'image-size';

/**
 * Max image dimension (px) for many-image API requests.
 * Anthropic returns a non-retryable 400 when any image exceeds this in a multi-image request.
 */
export const MANY_IMAGE_MAX_DIMENSION = 2000;

/** Returns true if buffer is an image exceeding the many-image dimension limit. */
export function isOversizedImage(buffer: Buffer | Uint8Array): boolean {
  try {
    const { width, height } = imageSize(buffer);
    return (
      width > MANY_IMAGE_MAX_DIMENSION || height > MANY_IMAGE_MAX_DIMENSION
    );
  } catch {
    // Unrecognized or truncated image data — nothing to measure.
    return false;
  }
}
