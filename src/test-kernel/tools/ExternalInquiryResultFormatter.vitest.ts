import { describe, expect, it } from 'vitest';

import type { ExternalInquiryThreadManifest } from '@tools/inquiry/externalInquiryStorage';
import { collectKnownSessionLinks } from '@tools/inquiry/externalInquiryResultFormatter';

function manifestWithSessionLinks(
  turns: Array<{ turnIndex: number; sessionLinks?: string[] | null }>,
): ExternalInquiryThreadManifest {
  return {
    schemaVersion: 1,
    threadId: 'thread-1',
    parentStreamId: null,
    status: 'answered',
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
    turns: turns.map((turn) => ({
      kind: 'answered',
      turnIndex: turn.turnIndex,
      timestamp: `2026-05-16T00:00:0${turn.turnIndex}.000Z`,
      parentGenerationId: 'f9de9269-9198-4103-a248-6a3bd78bd4eb',
      question: `Q${turn.turnIndex}`,
      context: undefined,
      questionRelativePath: `turn-${turn.turnIndex}/question.md`,
      contextRelativePath: undefined,
      answerRelativePath: `turn-${turn.turnIndex}/answer.md`,
      sessionLinks: turn.sessionLinks ?? undefined,
      answer: `A${turn.turnIndex}`,
      answeredAt: `2026-05-16T00:00:0${turn.turnIndex}.000Z`,
      suggestSearch: undefined,
      attachFiles: undefined,
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
