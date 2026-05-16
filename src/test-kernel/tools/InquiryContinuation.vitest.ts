/**
 * Vitests for the inquiry continuation text builder.
 */
import { describe, expect, it } from 'vitest';

import { buildContinuationText } from '@tools/inquiry/inquiryContinuation';
import type {
  ExternalInquiryThreadId,
  ExternalInquiryThreadSummary,
  StreamTabId,
} from '@shared/schemas';

const STREAM = 'stream:test' as StreamTabId;
const THREAD: ExternalInquiryThreadId =
  'ei_aabbccdd0011' as ExternalInquiryThreadId;
const OTHER_THREAD: ExternalInquiryThreadId =
  'ei_ffff00001122' as ExternalInquiryThreadId;

function makeSummary(
  partial: Partial<ExternalInquiryThreadSummary>,
): ExternalInquiryThreadSummary {
  return {
    threadId: OTHER_THREAD,
    parentStreamId: STREAM,
    status: 'open',
    lastQuestionPreview: 'Prove Lemma 3.2 from manuscript',
    lastActivityIso: new Date(Date.now() - 12 * 60_000).toISOString(),
    turnCount: 1,
    ...partial,
  };
}

describe('buildContinuationText', () => {
  it('emits Variant A when there are other open inquiries (answered)', () => {
    const text = buildContinuationText({
      event: 'answered',
      threadId: THREAD,
      question: 'Q',
      answer: 'A',
      stillOpen: [makeSummary({})],
    });

    expect(text).toContain(`[inquiry] ${THREAD} answered.`);
    expect(text).toContain('Q: Q');
    expect(text).toContain('A: A');
    expect(text).toContain('Still open on this stream:');
    expect(text).toContain(OTHER_THREAD);
    expect(text).toContain(
      'Proceed using the new answer. Do not re-dispatch any open thread_id.',
    );
  });

  it('emits Variant B when no other inquiries are open (answered)', () => {
    const text = buildContinuationText({
      event: 'answered',
      threadId: THREAD,
      question: 'Q',
      answer: 'A',
      stillOpen: [],
    });

    expect(text).toContain('No other open inquiries on this stream.');
    expect(text).toContain('Proceed using the new answer.');
    expect(text).not.toContain('Still open on this stream:');
  });

  it('emits Variant C for dropped threads', () => {
    const text = buildContinuationText({
      event: 'dropped',
      threadId: THREAD,
      question: 'Q',
      stillOpen: [makeSummary({})],
    });

    expect(text).toContain(`[inquiry] ${THREAD} dropped by user.`);
    expect(text).toContain('Q: Q');
    expect(text).toContain('re-formulate (new thread)');
    expect(text).toContain(`Do not re-dispatch ${THREAD}.`);
  });

  it('truncates long questions and answers', () => {
    const longQ = 'q'.repeat(1000);
    const longA = 'a'.repeat(5000);
    const text = buildContinuationText({
      event: 'answered',
      threadId: THREAD,
      question: longQ,
      answer: longA,
      stillOpen: [],
    });

    expect(text).toContain(
      `(full text via inquiry { command: 'read', thread_id: '${THREAD}' })`,
    );
    expect(text.length).toBeLessThan(longQ.length + longA.length);
  });
});
