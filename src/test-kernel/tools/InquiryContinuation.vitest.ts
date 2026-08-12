import { describe, expect, it } from 'vitest';

import type {
  InquiryThreadId,
  InquiryThreadSummary,
  StreamTabId,
} from '@shared/schemas';
import { buildContinuationText } from '@tools/inquiry/inquiryContinuation';

const STREAM = 'stream:test' as StreamTabId;
const THREAD: InquiryThreadId =
  'ei_aabbccdd0011' as InquiryThreadId;
const OTHER_THREAD: InquiryThreadId =
  'ei_ffff00001122' as InquiryThreadId;

function makeSummary(
  partial: Partial<InquiryThreadSummary>,
): InquiryThreadSummary {
  return {
    threadId: OTHER_THREAD,
    parentStreamId: STREAM,
    status: 'open',
    lastQuestionPreview: 'Prove Lemma 3.2 from manuscript',
    lastActivityIso: '2026-08-06T11:48:00.000Z',
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
    expect(text).toContain(`Full thread: ${THREAD}`);
    expect(text).not.toContain(`inquiry { command: 'read'`);
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
    expect(text).toContain(`Full thread: ${THREAD}`);
    expect(text).not.toContain(`inquiry { command: 'read'`);
    expect(text).toContain('re-formulate (new thread)');
    expect(text).toContain(`Do not re-dispatch ${THREAD}.`);
  });

  it('collapses multiline markdown previews to avoid rendering code blocks', () => {
    const text = buildContinuationText({
      event: 'answered',
      threadId: THREAD,
      question: [
        'Please run this analysis:',
        '',
        '```bash',
        'grep -rn "SameMPV₂" TNLean',
        '```',
      ].join('\n'),
      answer: ['```text', 'do subagent; not inquiry', '```'].join('\n'),
      stillOpen: [],
    });

    expect(text).toContain(
      'Q: Please run this analysis: ```bash grep -rn "SameMPV₂" TNLean ```',
    );
    expect(text).toContain('A: ```text do subagent; not inquiry ```');
    expect(text.split('\n').some((line) => line.startsWith('```'))).toBe(false);
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

    expect(text).toContain(`(full text available in thread ${THREAD})`);
    expect(text).not.toContain(`inquiry { command: 'read'`);
    expect(text.length).toBeLessThan(longQ.length + longA.length);
  });
});
