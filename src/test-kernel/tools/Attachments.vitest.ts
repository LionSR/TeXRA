import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { buildBytesAttachment } from '@tools/attachments';

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

describe('buildBytesAttachment oversized-image handling', () => {
  it.effect('strips binary data from images beyond the dimension limit', () =>
    Effect.gen(function* () {
      for (const bytes of [pngHeader(2001, 100), pngHeader(100, 2001)]) {
        const attachment = yield* buildBytesAttachment({
          path: 'figure.png',
          mimeType: 'image/png',
          bytes,
        });
        expect(attachment.bytes).toBeUndefined();
        expect(attachment.description).toBe(
          'Image exceeds 2000px dimension limit; binary data stripped',
        );
      }
    }),
  );
});
