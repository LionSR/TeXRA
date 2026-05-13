// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - schemas
import type { ExternalInquiryThreadId } from '@shared/schemas';

// Local imports - external inquiry
import type {
  ExternalInquiryThreadManifest,
  ExternalInquiryTurnRecord,
  PersistedExternalInquiryTurn,
} from '@tools/inquiry/externalInquiryStorage';
import {
  buildExternalInquiryResult,
  collectKnownSessionLinks,
} from '@tools/inquiry/externalInquiryResultFormatter';

const THREAD_ID = 'ei_012345abcdef' as ExternalInquiryThreadId;
const TIMESTAMP = '2026-05-13T00:00:00.000Z';

function makeTurn(
  turnIndex: number,
  sessionLinks?: string[],
): ExternalInquiryTurnRecord {
  return {
    turnIndex,
    timestamp: TIMESTAMP,
    question: `Question ${turnIndex}`,
    context: undefined,
    questionRelativePath: `t${turnIndex}/question.txt`,
    contextRelativePath: undefined,
    answerRelativePath: `t${turnIndex}/answer.txt`,
    sessionLinks,
  };
}

function makeManifest(
  turns: ExternalInquiryTurnRecord[],
): ExternalInquiryThreadManifest {
  return {
    threadId: THREAD_ID,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    turns,
  };
}

function makePersistedTurn(
  sessionLinks?: string[],
): PersistedExternalInquiryTurn {
  const turn = makeTurn(1, sessionLinks);
  return {
    threadId: THREAD_ID,
    manifest: makeManifest([turn]),
    turn,
  };
}

function makeFollowUpPersistedTurn(): PersistedExternalInquiryTurn {
  const firstTurn = makeTurn(1, ['https://chatgpt.com/c/original']);
  const followUpTurn = makeTurn(2);
  return {
    threadId: THREAD_ID,
    manifest: makeManifest([firstTurn, followUpTurn]),
    turn: followUpTurn,
  };
}

describe('external inquiry session links', () => {
  it('collects known session links from newest to oldest without duplicates', () => {
    expect(
      collectKnownSessionLinks(
        makeManifest([
          makeTurn(1, [
            'https://chatgpt.com/c/old',
            'https://claude.ai/chat/a',
          ]),
          makeTurn(2, [
            'https://chatgpt.com/c/new',
            'https://chatgpt.com/c/old',
          ]),
        ]),
      ),
    ).toEqual([
      'https://chatgpt.com/c/new',
      'https://chatgpt.com/c/old',
      'https://claude.ai/chat/a',
    ]);
  });

  it('tells the agent to reuse the thread id when session links exist', () => {
    const result = buildExternalInquiryResult({
      persisted: makePersistedTurn(['https://chatgpt.com/c/thread']),
      answer: 'The calculation is consistent.',
      includeLongAnswerRedirect: false,
    });

    expect(result.output).toContain(`Use thread_id=${THREAD_ID}`);
    expect(result.output).toContain('known external session links');
    expect(result.output).toContain('- https://chatgpt.com/c/thread');
  });

  it('asks for external chat URLs when no session link was captured', () => {
    const result = buildExternalInquiryResult({
      persisted: makePersistedTurn(),
      answer: 'The calculation is consistent.',
      includeLongAnswerRedirect: false,
    });

    expect(result.output).toContain('paste the external chat URL');
  });

  it('uses older manifest links when a follow-up turn adds no new link', () => {
    const result = buildExternalInquiryResult({
      persisted: makeFollowUpPersistedTurn(),
      answer: 'The follow-up answer is consistent.',
      includeLongAnswerRedirect: false,
    });

    expect(result.output).toContain('known external session links');
    expect(result.output).toContain('- https://chatgpt.com/c/original');
  });
});
