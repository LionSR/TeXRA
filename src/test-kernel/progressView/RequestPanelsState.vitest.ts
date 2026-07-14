import { describe, expect, it } from 'vitest';

import { selectExternalInquiryKey } from '@progressView/frontend/components/RequestPanelsState';

describe('external inquiry carousel selection', () => {
  it('selects the first inquiry when no selection exists', () => {
    expect(selectExternalInquiryKey(null, [], ['a', 'b'])).toBe('a');
  });

  it('retains the selected inquiry when earlier entries change', () => {
    expect(selectExternalInquiryKey('b', ['a', 'b'], ['new', 'a', 'b'])).toBe(
      'b',
    );
    expect(selectExternalInquiryKey('b', ['a', 'b'], ['b'])).toBe('b');
  });

  it('selects the next inquiry when the selected entry is removed', () => {
    expect(selectExternalInquiryKey('b', ['a', 'b', 'c'], ['a', 'c'])).toBe(
      'c',
    );
  });

  it('falls back to the previous inquiry when the last entry is removed', () => {
    expect(selectExternalInquiryKey('c', ['a', 'b', 'c'], ['a', 'b'])).toBe(
      'b',
    );
  });

  it('clears selection with the carousel', () => {
    expect(selectExternalInquiryKey('a', ['a'], [])).toBeNull();
  });
});
