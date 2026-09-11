import { describe, expect, it } from 'vitest';

import type {
  InquiryThreadId,
  InquiryThreadSummary,
  RunId,
} from '@shared/schemas';
import { buildContinuationText } from '@tools/inquiry/inquiryContinuation';

const STREAM = 'stream:test' as RunId;
const THREAD: InquiryThreadId = 'ei_aabbccdd0011' as InquiryThreadId;
const OTHER_THREAD: InquiryThreadId = 'ei_ffff00001122' as InquiryThreadId;

function makeSummary(
  partial: Partial<InquiryThreadSummary>,
): InquiryThreadSummary {
  return {
    threadId: OTHER_THREAD,
    parentRunId: STREAM,
    status: 'open',
    lastQuestionPreview: 'Prove Lemma 3.2 from manuscript',
    lastActivityIso: '2026-08-06T11:48:00.000Z',
    turnCount: 1,
    ...partial,
  };
}

describe('buildContinuationText', () => {
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
