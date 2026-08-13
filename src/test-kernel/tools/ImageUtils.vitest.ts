import { describe, expect, it } from 'vitest';

import { isOversizedImage } from '@tools/imageUtils';

/** Minimal PNG header (signature + IHDR) with the given dimensions. */
function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    ihdr,
  ]);
}

describe('isOversizedImage', () => {
  it('flags images beyond the many-image dimension limit', () => {
    expect(isOversizedImage(pngHeader(2001, 100))).toBe(true);
    expect(isOversizedImage(pngHeader(100, 2001))).toBe(true);
  });

  it('accepts images within the limit', () => {
    expect(isOversizedImage(pngHeader(2000, 2000))).toBe(false);
  });

  it('treats unrecognized data as not oversized', () => {
    expect(isOversizedImage(Buffer.from('plain text, not an image'))).toBe(
      false,
    );
    expect(isOversizedImage(Buffer.alloc(0))).toBe(false);
  });
});
