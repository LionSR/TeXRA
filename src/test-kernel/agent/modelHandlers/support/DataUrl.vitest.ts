import { describe, expect, it } from 'vitest';

import { toDataUrl } from '@agent/modelHandlers/support/dataUrl';

describe('toDataUrl', () => {
  it('builds a data URL from a media type and base64 payload', () => {
    expect(toDataUrl('application/pdf', 'ABC123')).toBe(
      'data:application/pdf;base64,ABC123',
    );
  });
});
