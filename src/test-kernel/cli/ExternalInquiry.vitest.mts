import { describe, expect, it } from 'vitest';

import {
  boundedExternalInquiryQuestionLines,
  externalInquiryAnswerRowsBudget,
  externalInquiryKeyHintsForWidth,
  externalInquiryQuestionRowsBudget,
} from '@cli/chat/tui/modals/ExternalInquiry';
import { KEY_HINT_SEPARATOR } from '@cli/chat/tui/ui/KeyHints';
import { textInputDisplayWindow } from '@cli/chat/tui/input/BaseTextInput';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';

describe('CLI external inquiry modal', () => {
  function hintText(
    hints: ReturnType<typeof externalInquiryKeyHintsForWidth>,
  ): string {
    return hints
      .map((hint) => `${hint.key} ${hint.action}`)
      .join(KEY_HINT_SEPARATOR);
  }

  it('preserves the skip hint when the full hint row is one column too wide', () => {
    const text = hintText(
      externalInquiryKeyHintsForWidth({
        questionScrollable: true,
        maxColumns: 76,
      }),
    );

    expect(text).toBe(
      'PgUp/PgDn scroll · Enter submit answer · Ctrl-R reject with note · Esc skip',
    );
    expect(text.length).toBeLessThan(76);
  });

  it('compacts before using a hint row that exactly matches the width', () => {
    const text = hintText(
      externalInquiryKeyHintsForWidth({
        questionScrollable: true,
        maxColumns: 77,
      }),
    );

    expect(text).toBe(
      'PgUp/PgDn scroll · Enter submit answer · Ctrl-R reject with note · Esc skip',
    );
    expect(text.length).toBeLessThan(77);
  });

  it('keeps the full scrollable hint row when there is spare width', () => {
    const text = hintText(
      externalInquiryKeyHintsForWidth({
        questionScrollable: true,
        maxColumns: 78,
      }),
    );

    expect(text).toBe(
      'PgUp/PgDn question · Enter submit answer · Ctrl-R reject with note · Esc skip',
    );
    expect(text.length).toBeLessThan(78);
  });

  it('preserves the scroll hint when compact action labels fit', () => {
    const text = hintText(
      externalInquiryKeyHintsForWidth({
        questionScrollable: true,
        maxColumns: 58,
      }),
    );

    expect(text).toBe(
      'PgUp/Dn scroll · Enter submit · Ctrl-R reject · Esc skip',
    );
    expect(text.length).toBeLessThan(58);
  });

  it('keeps core external inquiry actions visible in narrow modals', () => {
    const text = hintText(
      externalInquiryKeyHintsForWidth({
        questionScrollable: true,
        maxColumns: 56,
      }),
    );

    expect(text).toBe('Enter submit · Ctrl-R reject · Esc skip');
    expect(text.length).toBeLessThan(56);
  });

  it('continues shrinking non-scrollable hints when compact actions do not fit', () => {
    const text = hintText(
      externalInquiryKeyHintsForWidth({
        questionScrollable: false,
        maxColumns: 20,
      }),
    );

    expect(text).toBe('Esc skip');
    expect(text.length).toBeLessThan(20);
  });

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

  it('does not exceed tiny foreground row budgets with question rows', () => {
    const answerRows = externalInquiryAnswerRowsBudget(7);
    const questionRows = externalInquiryQuestionRowsBudget({
      answerRows,
      availableRows: 7,
    });

    expect(answerRows).toBe(1);
    expect(questionRows).toBe(0);
    expect(
      boundedExternalInquiryQuestionLines({
        maxDisplayLines: questionRows,
        question: 'hidden question',
        width: 80,
      }),
    ).toEqual([]);
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

  it('wraps long answers at word boundaries when there is a nearby break', () => {
    const value =
      'Independent check agrees: there are 22 non-degenerate triples in the displayed list, plus exactly 61 degenerate triples.';
    const display = textInputDisplayWindow({
      cursor: value.length,
      maxDisplayRows: 3,
      value,
      width: 72,
    });

    expect(display.value).toContain('\ndisplayed list');
    expect(display.value).not.toContain('dis\nplayed');
  });

  it('does not render a whitespace-only row after an exact-width word', () => {
    const value = 'hello world';
    const display = textInputDisplayWindow({
      cursor: value.length,
      maxDisplayRows: 3,
      value,
      width: 5,
    });

    expect(display.value).toBe('hello\nworld');
  });

  it('does not wrap back to distant whitespace before a long token', () => {
    const value = `a ${'x'.repeat(80)}`;
    const display = textInputDisplayWindow({
      cursor: value.length,
      maxDisplayRows: 3,
      value,
      width: 80,
    });

    expect(display.value.split('\n')).toEqual([`a ${'x'.repeat(78)}`, 'xx']);
  });

  it('uses terminal display width when wrapping wide answer text', () => {
    const display = textInputDisplayWindow({
      cursor: '１２３４５'.length,
      maxDisplayRows: 4,
      value: '１２３４５',
      width: 6,
    });

    expect(display.value.split('\n').map(textDisplayWidth)).toEqual([6, 4]);
  });

  it('keeps Esc skip readable when scroll hints make the footer tight', () => {
    expect(
      externalInquiryKeyHintsForWidth({
        maxColumns: 76,
        questionScrollable: true,
      }),
    ).toEqual([
      { key: 'PgUp/PgDn', action: 'scroll' },
      { key: 'Enter', action: 'submit answer' },
      { key: 'Ctrl-R', action: 'reject with note' },
      { key: 'Esc', action: 'skip' },
    ]);

    expect(
      externalInquiryKeyHintsForWidth({
        maxColumns: 38,
        questionScrollable: true,
      }),
    ).toEqual([
      { key: 'Enter', action: 'submit' },
      { key: 'Esc', action: 'skip' },
    ]);
  });

  it('uses full external inquiry hints when the question is not scrollable', () => {
    expect(
      externalInquiryKeyHintsForWidth({
        maxColumns: 76,
        questionScrollable: false,
      }),
    ).toEqual([
      { key: 'Enter', action: 'submit answer' },
      { key: 'Ctrl-R', action: 'reject with note' },
      { key: 'Esc', action: 'skip' },
    ]);
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
