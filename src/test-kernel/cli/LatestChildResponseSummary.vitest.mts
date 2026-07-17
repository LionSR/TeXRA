import { describe, expect, it } from 'vitest';

import { latestChildResponseSummary } from '@cli/chat/tui/state/childControls';
import { MESSAGE_TYPES } from '@shared/schemas';
import type { ConversationEntry } from '@cli/chat/tui/state/cliState';

function user(text: string): ConversationEntry {
  return { id: `u-${text}`, role: 'user', text, finalized: true };
}

function reply(text: string, finalized = true): ConversationEntry {
  return {
    id: `a-${text}`,
    role: 'assistant',
    text,
    finalized,
    messageType: MESSAGE_TYPES.MODEL_RESPONSE,
  };
}

describe('latest child response summary', () => {
  it('prefers the final response after the newest instruction', () => {
    expect(
      latestChildResponseSummary([
        user('check the proof'),
        reply('first draft'),
        user('now verify lemma 2'),
        reply('lemma 2 holds'),
      ]),
    ).toBe('lemma 2 holds');
  });

  it('falls back to the instruction while the turn still streams', () => {
    expect(
      latestChildResponseSummary([
        user('now verify lemma 2'),
        reply('working…', false),
      ]),
    ).toBe('now verify lemma 2');
  });

  it('caches per entries version, including empty results', () => {
    const entries: readonly ConversationEntry[] = [];
    expect(latestChildResponseSummary(entries)).toBeUndefined();
    expect(latestChildResponseSummary(entries)).toBeUndefined();
    expect(latestChildResponseSummary(undefined)).toBeUndefined();
  });
});
