import { describe, expect, it } from 'vitest';

import {
  boundedExternalInquiryQuestionLines,
  externalInquiryAnswerRowsBudget,
  externalInquiryKeyHintsForWidth,
  externalInquiryQuestionRowsBudget,
} from '@cli/chat/tui/modals/ExternalInquiry';
import { KEY_HINT_SEPARATOR } from '@cli/tui/ui/KeyHints';
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

  /** Answer input window with the caret at the end of the typed value. */
  function displayAtEnd(
    value: string,
    width: number,
    maxDisplayRows = 3,
  ): ReturnType<typeof textInputDisplayWindow> {
    return textInputDisplayWindow({
      cursor: value.length,
      maxDisplayRows,
      value,
      width,
    });
  }

  it.each([
    {
      name: 'preserves the skip hint when the full hint row is one column too wide',
      questionScrollable: true,
      maxColumns: 76,
      expected:
        'PgUp/PgDn scroll · Ctrl-Y copy · Enter submit · Ctrl-R reject · Esc skip',
    },
    {
      name: 'compacts before using a hint row that exactly matches the width',
      questionScrollable: true,
      maxColumns: 77,
      expected:
        'PgUp/PgDn scroll · Ctrl-Y copy · Enter submit · Ctrl-R reject · Esc skip',
    },
    {
      name: 'keeps the full scrollable hint row when there is spare width',
      questionScrollable: true,
      maxColumns: 101,
      expected:
        'PgUp/PgDn question · Ctrl-Y copy question · Enter submit answer · Ctrl-R reject with note · Esc skip',
    },
    {
      name: 'keeps copy and core actions before scroll in tight modals',
      questionScrollable: true,
      maxColumns: 58,
      expected: 'Ctrl-Y copy · Enter submit · Ctrl-R reject · Esc skip',
    },
    {
      name: 'keeps core external inquiry actions visible in narrow modals',
      questionScrollable: true,
      maxColumns: 56,
      expected: 'Ctrl-Y copy · Enter submit · Ctrl-R reject · Esc skip',
    },
    {
      name: 'continues shrinking non-scrollable hints when compact actions do not fit',
      questionScrollable: false,
      maxColumns: 20,
      expected: 'Esc skip',
    },
  ])('$name', ({ questionScrollable, maxColumns, expected }) => {
    const text = hintText(
      externalInquiryKeyHintsForWidth({ questionScrollable, maxColumns }),
    );

    expect(text).toBe(expected);
    expect(text.length).toBeLessThan(maxColumns);
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
    const display = displayAtEnd(value, 72);

    expect(display.value).toContain('\ndisplayed list');
    expect(display.value).not.toContain('dis\nplayed');
  });

  it('does not render a whitespace-only row after an exact-width word', () => {
    expect(displayAtEnd('hello world', 5).value).toBe('hello\nworld');
  });

  it('does not render a blank row from consecutive soft-break spaces', () => {
    expect(displayAtEnd('hell  world', 5).value).toBe('hell\nworld');
  });

  it('does not render a blank row for trailing wrapped whitespace', () => {
    const display = displayAtEnd('hello ', 5);

    expect(display.value).toBe('hello');
    expect(display.cursor).toBe(display.value.length);
  });

  it('skips space-only soft-wrap rows', () => {
    const display = displayAtEnd('   word', 2, 4);

    expect(display.value.split('\n')).not.toContain('');
    expect(display.value).toBe('wo\nrd');
  });

  it('keeps the cursor aligned when clipped ellipsis precedes trimmed text', () => {
    const value = 'aaaaa hell  world';
    const display = textInputDisplayWindow({
      cursor: 'aaaaa hell'.length,
      maxDisplayRows: 1,
      value,
      width: 5,
    });

    expect(display.value).toBe('…hell');
    expect(display.cursor).toBe(display.value.length);
  });

  it('uses display width for clipped ellipsis cursor alignment', () => {
    const value = 'abcdef １２３';
    const display = textInputDisplayWindow({
      cursor: 'abcdef １'.length,
      maxDisplayRows: 1,
      value,
      width: 6,
    });

    expect(display.value).toBe('…２３');
    expect(display.cursor).toBe(1);
  });

  it('does not wrap back to distant whitespace before a long token', () => {
    const display = displayAtEnd(`a ${'x'.repeat(80)}`, 80);

    expect(display.value.split('\n')).toEqual([`a ${'x'.repeat(78)}`, 'xx']);
  });

  it('uses terminal display width when wrapping wide answer text', () => {
    const display = displayAtEnd('１２３４５', 6, 4);

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
      { key: 'Ctrl-Y', action: 'copy' },
      { key: 'Enter', action: 'submit' },
      { key: 'Ctrl-R', action: 'reject' },
      { key: 'Esc', action: 'skip' },
    ]);

    expect(
      externalInquiryKeyHintsForWidth({
        maxColumns: 38,
        questionScrollable: true,
      }),
    ).toEqual([
      { key: 'Ctrl-Y', action: 'copy' },
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
      { key: 'Ctrl-Y', action: 'copy' },
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
    const display = displayAtEnd(value, 80, 2);

    expect(display.clipped).toBe(true);
    expect(display.value.split('\n')).toHaveLength(2);
    expect(display.value.startsWith('…')).toBe(true);
    expect(display.cursor).toBe(display.value.length);
  });
});
