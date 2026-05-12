/**
 * Max image dimension (px) for many-image API requests.
 * Anthropic returns a non-retryable 400 when any image exceeds this in a multi-image request.
 */
export const MANY_IMAGE_MAX_DIMENSION = 2000;

/** Max bytes to scan for JPEG SOF markers — all well-formed JPEGs have SOF within the first 64 KB. */
const JPEG_MAX_SCAN_BYTES = 65536;

/**
 * Parse image dimensions from buffer header bytes (PNG, JPEG, GIF, WebP).
 * Returns undefined if format is unrecognized or header is truncated.
 */
export function getImageDimensionsFromBuffer(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  if (buffer.length < 10) return undefined;

  // PNG: width@16 and height@20 (4 bytes BE each)
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    if (buffer.length < 24) return undefined;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF: width@6 and height@8 (2 bytes LE each)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // JPEG: scan for SOF markers (bounded to first 64 KB)
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    const limit = Math.min(buffer.length, JPEG_MAX_SCAN_BYTES);
    let offset = 2;
    while (offset + 9 < limit) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      if (offset + 3 >= limit) return undefined;
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2) return undefined;
      offset += 2 + segmentLength;
    }
    return undefined;
  }

  // WebP: "RIFF" + 4 bytes + "WEBP", then VP8/VP8L/VP8X subtype
  if (
    buffer.length >= 30 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    if (
      buffer[12] === 0x56 &&
      buffer[13] === 0x50 &&
      buffer[14] === 0x38 &&
      buffer[15] === 0x20
    ) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (
      buffer[12] === 0x56 &&
      buffer[13] === 0x50 &&
      buffer[14] === 0x38 &&
      buffer[15] === 0x4c
    ) {
      if (buffer.length < 25) return undefined;
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (
      buffer[12] === 0x56 &&
      buffer[13] === 0x50 &&
      buffer[14] === 0x38 &&
      buffer[15] === 0x58
    ) {
      return {
        width: (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1,
        height: (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1,
      };
    }
  }

  return undefined;
}

/** Returns true if buffer is an image exceeding the many-image dimension limit. */
export function isOversizedImage(buffer: Buffer | Uint8Array): boolean {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const dims = getImageDimensionsFromBuffer(buf);
  if (!dims) return false;
  return (
    dims.width > MANY_IMAGE_MAX_DIMENSION ||
    dims.height > MANY_IMAGE_MAX_DIMENSION
  );
}
