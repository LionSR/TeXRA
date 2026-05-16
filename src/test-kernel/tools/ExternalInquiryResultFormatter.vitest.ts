import { describe, expect, it } from 'vitest';

import type { ExternalInquiryThreadManifest } from '@tools/inquiry/externalInquiryStorage';
import { collectKnownSessionLinks } from '@tools/inquiry/externalInquiryResultFormatter';

function manifestWithSessionLinks(
  turns: Array<{ turnIndex: number; sessionLinks?: string[] | null }>,
): ExternalInquiryThreadManifest {
  return {
    threadId: 'thread-1',
    parentStreamId: null,
    status: 'answered',
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
    turns: turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      timestamp: `2026-05-16T00:00:0${turn.turnIndex}.000Z`,
      question: `Q${turn.turnIndex}`,
      context: null,
      questionRelativePath: `turn-${turn.turnIndex}/question.md`,
      contextRelativePath: null,
      answerRelativePath: null,
      sessionLinks: turn.sessionLinks,
      answer: null,
      answeredAt: null,
      suggestSearch: null,
      attachFiles: null,
      draft: null,
    })),
  };
}

describe('collectKnownSessionLinks', () => {
  it('returns undefined for an absent or link-free manifest', () => {
    expect(collectKnownSessionLinks(null)).toBeUndefined();
    expect(
      collectKnownSessionLinks(
        manifestWithSessionLinks([
          { turnIndex: 1, sessionLinks: null },
          { turnIndex: 2 },
        ]),
      ),
    ).toBeUndefined();
  });

  it('deduplicates links in most-recent-turn order', () => {
    const manifest = manifestWithSessionLinks([
      {
        turnIndex: 1,
        sessionLinks: [
          'https://chat.example/old',
          'https://chat.example/shared',
        ],
      },
      {
        turnIndex: 2,
        sessionLinks: [
          'https://chat.example/new',
          'https://chat.example/shared',
        ],
      },
    ]);

    expect(collectKnownSessionLinks(manifest)).toEqual([
      'https://chat.example/new',
      'https://chat.example/shared',
      'https://chat.example/old',
    ]);
  });
});
