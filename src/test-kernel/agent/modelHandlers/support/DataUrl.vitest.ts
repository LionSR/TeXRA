import { describe, expect, it } from 'vitest';

import { parseDataUrl, toDataUrl } from '@agent/modelHandlers/support/dataUrl';

describe('toDataUrl', () => {
  it('builds a data URL from a media type and base64 payload', () => {
    expect(toDataUrl('application/pdf', 'ABC123')).toBe(
      'data:application/pdf;base64,ABC123',
    );
  });
});

describe('parseDataUrl', () => {
  it('parses a simple media type and base64 payload', () => {
    expect(parseDataUrl('data:application/pdf;base64,ABC123')).toEqual({
      mediaType: 'application/pdf',
      base64Data: 'ABC123',
    });
  });

  it('parses a media type with extra parameters before the base64 marker', () => {
    expect(
      parseDataUrl('data:application/pdf;charset=utf-8;base64,ABC123'),
    ).toEqual({
      mediaType: 'application/pdf;charset=utf-8',
      base64Data: 'ABC123',
    });
  });

  it('returns undefined for a raw base64 string with no data URL prefix', () => {
    expect(parseDataUrl('ABC123')).toBeUndefined();
  });
});
