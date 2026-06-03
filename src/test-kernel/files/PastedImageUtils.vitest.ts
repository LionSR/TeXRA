// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { pastedImageFileName } from '@utils/files/pastedImageUtils';

describe('pastedImageFileName', () => {
  it('accepts generated pasted image basenames', () => {
    expect(pastedImageFileName('pasted_1234_abcd.png')).toBe(
      'pasted_1234_abcd.png',
    );
  });

  it('rejects paths and non-pasted names from webview input', () => {
    for (const name of [
      '../pasted_1234_abcd.png',
      '/tmp/pasted_1234_abcd.png',
      'C:\\tmp\\pasted_1234_abcd.png',
      'avatar.png',
      '',
    ]) {
      expect(() => pastedImageFileName(name)).toThrow(
        'Invalid pasted image filename.',
      );
    }
  });
});
