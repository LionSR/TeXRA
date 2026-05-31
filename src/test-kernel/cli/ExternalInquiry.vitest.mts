import { describe, expect, it } from 'vitest';

import {
  boundedExternalInquiryQuestionLines,
  externalInquiryAnswerRowsBudget,
  externalInquiryQuestionRowsBudget,
} from '@cli/chat/tui/modals/ExternalInquiry';
import { textInputDisplayWindow } from '@cli/chat/tui/input/BaseTextInput';

describe('CLI external inquiry modal', () => {
  it('bounds long question text to the foreground row budget', () => {
    const answerRows = externalInquiryAnswerRowsBudget(18);
    const questionRows = externalInquiryQuestionRowsBudget({
      answerRows,
      availableRows: 18,
    });
    const lines = boundedExternalInquiryQuestionLines({
      maxDisplayLines: questionRows,
      question: Array.from(
        { length: 24 },
        (_, index) => `Question detail row ${index + 1}`,
      ).join('\n'),
      width: 80,
    });

    expect(lines).toHaveLength(questionRows);
    expect(lines.at(-1)).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('more rows'),
    });
  });

  it('keeps compact long questions scrollable', () => {
    const question = Array.from(
      { length: 8 },
      (_, index) => `Question detail row ${index + 1}`,
    ).join('\n');
    const lines = boundedExternalInquiryQuestionLines({
      maxDisplayLines: 3,
      question,
      scrollOffset: 3,
      width: 80,
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]?.text).toBe('Question detail row 4');
    expect(lines.at(-1)).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('previous'),
    });
    expect(lines.at(-1)?.text).toContain('more rows');
  });

  it('keeps the answer caret in the visible clipped input window', () => {
    const display = textInputDisplayWindow({
      cursor: 170,
      maxDisplayRows: 2,
      value: 'Independent verification '.repeat(8),
      width: 32,
    });

    expect(display.clipped).toBe(true);
    expect(display.value.startsWith('…')).toBe(true);
    expect(display.cursor).toBeGreaterThan(0);
    expect(display.cursor).toBeLessThanOrEqual(display.value.length);
  });

  it('counts literal newlines against the clipped input row budget', () => {
    const value = [
      'line one',
      'line two',
      'line three',
      'line four',
      'line five',
    ].join('\n');
    const display = textInputDisplayWindow({
      cursor: value.length,
      maxDisplayRows: 2,
      value,
      width: 80,
    });

    expect(display.clipped).toBe(true);
    expect(display.value.split('\n')).toHaveLength(2);
    expect(display.value.startsWith('…')).toBe(true);
    expect(display.cursor).toBe(display.value.length);
  });
});
