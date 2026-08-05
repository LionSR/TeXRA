import { describe, expect, it } from 'vitest';

import {
  sgrStrippingWriteStream,
  stripAnsiSgrChunk,
} from '@cli/tui/noColorOutput';

describe('TUI no-color output', () => {
  function fakeWriteStream(): { stream: NodeJS.WriteStream; writes: string[] } {
    const writes: string[] = [];
    const stream = {
      write(chunk: string | Uint8Array) {
        writes.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      },
    } as NodeJS.WriteStream;
    return { stream, writes };
  }

  it('strips SGR styling while preserving terminal control escapes', () => {
    const input = '\x1b[2mDim\x1b[22m\x1b[36m cyan\x1b[39m\x1b[2K\x1b[1;1H';

    expect(stripAnsiSgrChunk(input, { pending: '' })).toBe(
      'Dim cyan\x1b[2K\x1b[1;1H',
    );
  });

  it('strips SGR styling from byte chunks passed to write streams', () => {
    const { stream, writes } = fakeWriteStream();

    sgrStrippingWriteStream(stream).write(
      Buffer.from('\x1b[31mred\x1b[39m\x1b[2K'),
    );

    expect(writes).toEqual(['red\x1b[2K']);
  });

  it('keeps partial SGR sequences from leaking across writes', () => {
    const { stream, writes } = fakeWriteStream();
    const stripped = sgrStrippingWriteStream(stream);

    stripped.write('\x1b[');
    stripped.write('31mred\x1b[3');
    stripped.write('9m');

    expect(writes).toEqual(['red']);
  });

  it('preserves split non-SGR terminal control sequences', () => {
    const { stream, writes } = fakeWriteStream();
    const stripped = sgrStrippingWriteStream(stream);

    stripped.write('\x1b[');
    stripped.write('2Kclear');

    expect(writes).toEqual(['\x1b[2Kclear']);
  });
});
