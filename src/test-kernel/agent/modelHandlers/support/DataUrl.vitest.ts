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

  it('returns undefined for a ";base64," separator without the "data:" prefix', () => {
    // Documents an intentional behavior change from the original inline
    // openAIResponseFileUploads.ts extraction, which used a plain
    // `indexOf(';base64,')` and would have matched this input. The sole
    // caller always receives proper `data:` URLs from the OpenAI Response
    // API, so the stricter contract is safe there; this test exists so the
    // narrowing is documented rather than silently relied upon.
    expect(parseDataUrl('something;base64,ABC123')).toBeUndefined();
  });
});
