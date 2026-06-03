import { describe, expect, it } from 'vitest';

import { getExtensionFromMimeType } from '@shared/utils/clipboardImages';

describe('clipboard image helpers', () => {
  it('keeps legacy pasted-image MIME aliases', () => {
    expect(getExtensionFromMimeType('image/x-jng')).toBe('jng');
    expect(getExtensionFromMimeType('image/x-mng')).toBe('mng');
    expect(getExtensionFromMimeType('image/vnd.adobe.photoshop')).toBe('psd');
    expect(getExtensionFromMimeType('image/x-photoshop')).toBe('psd');
    expect(getExtensionFromMimeType('image/x-psd')).toBe('psd');
  });
});
