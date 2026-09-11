import { describe, expect, it } from 'vitest';

import {
  boundedUserQuestionPromptLines,
  isCompactUserQuestionRows,
  userQuestionChoiceRowsBudget,
  userQuestionFreeTextControlRows,
  userQuestionFreeTextOptionRowsBudget,
  userQuestionFreeTextSuggestionLine,
  userQuestionPromptRowsBudget,
} from '@cli/chat/tui/modals/UserQuestion';
import { textDisplayWidth } from '@cli/runtime/terminalText';

describe('CLI user question modal', () => {
  it('clips free-text suggestions and shows hidden option counts inline', () => {
    const line = userQuestionFreeTextSuggestionLine({
      option: {
        label: 'Use spectral truncation with a long explanatory label',
        description: 'This description should not take an extra row.',
      },
      optionIndex: 0,
      overflowText: '+2 more',
      width: 48,
    });

    expect(line).toContain('+2 more');
    expect(line).not.toContain('description');
    expect(textDisplayWidth(line)).toBeLessThanOrEqual(48);
  });

  it('clips long context from the top so the active question stays visible', () => {
    const lines = boundedUserQuestionPromptLines({
      context: [
        'Context row one with enough detail to matter.',
        'Context row two with enough detail to matter.',
        'Context row three with enough detail to matter.',
      ].join('\n'),
      maxDisplayLines: 3,
      question: '1/3 Which direction should the agent prioritize?',
      width: 80,
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('previous rows'),
    });
    expect(lines.at(-1)).toMatchObject({
      kind: 'question',
      text: expect.stringContaining('Which direction'),
    });
  });

  it('keeps the start of a wrapped active question when rows are tight', () => {
    const lines = boundedUserQuestionPromptLines({
      context: null,
      maxDisplayLines: 2,
      question:
        '1/1 Explain whether the finite approximation should use spectral truncation or direct enumeration for this proof.',
      width: 32,
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      kind: 'question',
      text: expect.stringContaining('clipped rows'),
    });
    expect(lines[0]?.text).toContain('1/1 Explain');
  });

  it('signals clipping inline when only one prompt row fits', () => {
    const lines = boundedUserQuestionPromptLines({
      context: 'Context row one.\nContext row two.',
      maxDisplayLines: 1,
      question: 'Continue?',
      width: 40,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: 'question',
      text: expect.stringContaining('clipped rows'),
    });
    expect(lines[0]?.text).toContain('Continue?');
  });
});
