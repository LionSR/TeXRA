import { describe, expect, it } from 'vitest';

import { getExtensionFromMimeType } from '@shared/utils/clipboardImages';

describe('clipboard image helpers', () => {
  it.each([
    ['image/x-jng', 'jng'],
    ['image/x-mng', 'mng'],
    ['image/vnd.adobe.photoshop', 'psd'],
    ['image/x-photoshop', 'psd'],
    ['image/x-psd', 'psd'],
  ])('keeps legacy pasted-image MIME alias %s', (mimeType, extension) => {
    expect(getExtensionFromMimeType(mimeType)).toBe(extension);
  });
});
