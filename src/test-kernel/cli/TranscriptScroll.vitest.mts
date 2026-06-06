import { describe, expect, it } from 'vitest';

import { scopedTranscriptVisibleLines } from '@cli/chat/tui/panes/ScopedTranscriptPane';
import {
  initialTranscriptScrollState,
  maxTranscriptScrollOffset,
  moveTranscriptScrollState,
  scrollTranscriptToOffset,
  syncTranscriptScrollState,
} from '@cli/chat/tui/state/transcriptScroll';

describe('CLI transcript scroll state', () => {
  it('opens scoped transcript history at the bottom', () => {
    const window = { lineCount: 20, viewRows: 5 };

    expect(maxTranscriptScrollOffset(window)).toBe(15);
    expect(initialTranscriptScrollState(window)).toEqual({
      offset: 15,
      followBottom: true,
    });
  });

  it('preserves manual scroll position while new lines arrive', () => {
    const bottom = initialTranscriptScrollState({ lineCount: 20, viewRows: 5 });
    const scrolled = moveTranscriptScrollState(
      bottom,
      { lineCount: 20, viewRows: 5 },
      -5,
    );

    expect(scrolled).toEqual({ offset: 10, followBottom: false });
    expect(
      syncTranscriptScrollState(scrolled, { lineCount: 30, viewRows: 5 }),
    ).toEqual({ offset: 10, followBottom: false });
  });

  it('continues following the bottom while armed', () => {
    const bottom = initialTranscriptScrollState({ lineCount: 20, viewRows: 5 });

    expect(
      syncTranscriptScrollState(bottom, { lineCount: 30, viewRows: 5 }),
    ).toEqual({ offset: 25, followBottom: true });
  });

  it('re-arms bottom following after paging back to the tail', () => {
    const scrolled = scrollTranscriptToOffset(
      { lineCount: 20, viewRows: 5 },
      15,
    );

    expect(scrolled).toEqual({ offset: 15, followBottom: true });
    expect(
      syncTranscriptScrollState(scrolled, { lineCount: 21, viewRows: 5 }),
    ).toEqual({ offset: 16, followBottom: true });
  });

  it('clamps manual offsets after content shrinks or the viewport grows', () => {
    expect(
      syncTranscriptScrollState(
        { offset: 15, followBottom: false },
        { lineCount: 12, viewRows: 8 },
      ),
    ).toEqual({ offset: 4, followBottom: false });
  });

  it('slices scoped transcript lines from the current scroll offset', () => {
    const lines = ['first', 'second', 'third', 'fourth'];

    expect(
      scopedTranscriptVisibleLines({ lines, offset: 0, viewRows: 2 }),
    ).toEqual(['first', 'second']);
    expect(
      scopedTranscriptVisibleLines({ lines, offset: 2, viewRows: 2 }),
    ).toEqual(['third', 'fourth']);
  });
});
