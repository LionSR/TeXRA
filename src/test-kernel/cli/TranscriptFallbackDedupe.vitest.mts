import { afterEach, describe, expect, it } from 'vitest';

import { appendAssistantTranscriptIfMissing } from '@cli/chat/tui/state/transcript';
import {
  cliState,
  patchStream,
  resetCliState,
  type ConversationEntry,
} from '@cli/chat/tui/state/cliState';
import type { StreamTabId } from '@shared/schemas';

const root = 'root' as StreamTabId;

afterEach(() => {
  resetCliState();
});

function entries(): readonly ConversationEntry[] {
  return cliState.streams.get().get(root)?.entries ?? [];
}

describe('CLI transcript fallback dedupe', () => {
  it('does not duplicate a final answer already present with markdown-only differences', () => {
    patchStream(root, (slice) => ({
      ...slice,
      entries: [
        ...slice.entries,
        {
          id: 'user:pell',
          role: 'user',
          text: 'Solve x^2 - 2 y^2 = 1 for 0 < y < 30.',
          finalized: true,
        },
        {
          id: 'log:answer',
          role: 'assistant',
          text: [
            '## All integer solutions',
            '',
            '$$x_1 + y_1\\sqrt{2} = (3 + 2\\sqrt{2})^1.$$',
            '',
            '$$',
            '\\begin{aligned}',
            'x_{n+1} &= 3x_n + 4y_n,\\\\[2pt]',
            'y_{n+1} &= 2x_n + 3y_n,',
            '\\end{aligned}',
            '$$',
            '',
            '$$\\boxed{(\\pm3,\\,2),\\qquad (\\pm17,\\,12)}$$',
          ].join('\n'),
          finalized: true,
        },
      ],
    }));

    appendAssistantTranscriptIfMissing(
      root,
      [
        '## All integer solutions',
        '',
        '$$x_1 + y_1\\sqrt{2} = (3 + 2\\sqrt{2})^1$$.',
        '',
        '$$',
        '\\begin{aligned}',
        'x_{n+1} &= 3x_n + 4y_n,\\\\',
        'y_{n+1} &= 2x_n + 3y_n,',
        '\\end{aligned}',
        '$$',
        '',
        '$$\\boxed{(\\pm3,\\,2),\\qquad (\\pm17,\\,12)}$$',
      ].join('\n'),
      'final:pell',
    );

    expect(
      entries().filter((entry) => entry.role === 'assistant'),
    ).toHaveLength(1);
  });

  it('keeps distinct assistant answers in the same turn', () => {
    patchStream(root, (slice) => ({
      ...slice,
      entries: [
        ...slice.entries,
        {
          id: 'user:theorem',
          role: 'user',
          text: 'State a simple theorem.',
          finalized: true,
        },
        {
          id: 'log:first-answer',
          role: 'assistant',
          text: 'There are infinitely many primes.',
          finalized: true,
        },
      ],
    }));

    appendAssistantTranscriptIfMissing(
      root,
      'The harmonic series diverges.',
      'final:second-answer',
    );

    expect(
      entries().filter((entry) => entry.role === 'assistant'),
    ).toHaveLength(2);
  });

  it('keeps answers that differ by mathematical operators or status glyphs', () => {
    patchStream(root, (slice) => ({
      ...slice,
      entries: [
        ...slice.entries,
        {
          id: 'user:comparison',
          role: 'user',
          text: 'Compare two proposed inequalities.',
          finalized: true,
        },
        {
          id: 'log:less-than',
          role: 'assistant',
          text: 'The condition is x < y and the check is ✓.',
          finalized: true,
        },
      ],
    }));

    appendAssistantTranscriptIfMissing(
      root,
      'The condition is x > y and the check is ✓.',
      'final:greater-than',
    );
    appendAssistantTranscriptIfMissing(
      root,
      'The condition is x > y and the check is ✗.',
      'final:failed-check',
    );

    expect(
      entries().filter((entry) => entry.role === 'assistant'),
    ).toHaveLength(3);
  });
});
