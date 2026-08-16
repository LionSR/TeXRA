/**
 * Parity test for the two `CONVERSATION_BLOCK_TYPES` consumers:
 * `assistantBlockToNode`/`blocksToUserParts` in
 * `@agent/export/normalizeConversation` and `formatConversationBlock` in
 * `@agent/storage/conversationFormat`. Both switches must recognize the same
 * block-type tags — one into structured `ExportNode`s, the other into
 * truncated marker strings. The tags themselves are already shared via the
 * frozen `CONVERSATION_BLOCK_TYPES` table; what this test pins is COVERAGE:
 * adding a member to that table fails here until both modules classify it,
 * and dropping a case from either switch fails the per-tag parity check.
 *
 * Known blind spot, documented rather than hidden: for the thinking tags the
 * export side is vacuous — `assistantBlockToNode` suppresses them (returns
 * null), which is also what its `case undefined` arm does with
 * unrecognized tags, so no behavioral probe can distinguish "recognized and
 * suppressed" from "unrecognized". The format side distinguishes them
 * (suppressed vs. JSON dump), so drift there is still caught.
 */

import { describe, expect, it } from 'vitest';

import { normalizeConversationForExport } from '@agent/export/normalizeConversation';
import { formatConversationContent } from '@agent/storage/conversationFormat';
import { CONVERSATION_BLOCK_TYPES } from '@agent/types/ConversationBlockTypes';

/** The classification both modules must agree on for each tag. */
type BlockBucket =
  'image' | 'document' | 'tool_use' | 'tool_result' | 'thinking';

const EXPECTED_BUCKET: Record<string, BlockBucket> = {
  [CONVERSATION_BLOCK_TYPES.image]: 'image',
  [CONVERSATION_BLOCK_TYPES.inputImage]: 'image',
  [CONVERSATION_BLOCK_TYPES.imageUrl]: 'image',
  [CONVERSATION_BLOCK_TYPES.document]: 'document',
  [CONVERSATION_BLOCK_TYPES.inputFile]: 'document',
  [CONVERSATION_BLOCK_TYPES.file]: 'document',
  [CONVERSATION_BLOCK_TYPES.toolUse]: 'tool_use',
  [CONVERSATION_BLOCK_TYPES.toolResult]: 'tool_result',
  [CONVERSATION_BLOCK_TYPES.thinking]: 'thinking',
  [CONVERSATION_BLOCK_TYPES.redactedThinking]: 'thinking',
};

/** One probe block carrying every field any arm of either switch reads. */
function probeBlock(tag: string): Record<string, unknown> {
  return {
    type: tag,
    name: 'probe',
    input: { a: 1 },
    content: 'probe-result',
    thinking: 'probe-thinking',
  };
}

/**
 * Bucket assigned by `formatConversationBlock` (via the exported
 * `formatConversationContent`). `hideProviderReasoning` collapses the
 * thinking arm to `''`, which the `case undefined` arm (a JSON dump) can
 * never produce for a non-empty probe block — so every recognized tag lands
 * in a bucket and every unrecognized one returns undefined.
 */
function formatBucket(tag: string): BlockBucket | undefined {
  const out = formatConversationContent([probeBlock(tag)], {
    hideProviderReasoning: true,
  });
  if (out === '[image attachment]') return 'image';
  if (out === '[document attachment]') return 'document';
  if (out === '[tool_use: probe({"a":1})]') return 'tool_use';
  if (out === '[tool_result: probe-result]') return 'tool_result';
  if (out === '') return 'thinking';
  return undefined;
}

/**
 * Bucket assigned by `normalizeConversationForExport`: attachment tags are
 * recognized by `blocksToUserParts` (user role), tool tags by
 * `assistantBlockToNode` (assistant role). Thinking tags are suppressed to
 * no node — see the module-doc blind-spot note.
 */
function normalizeBucket(tag: string): BlockBucket | undefined {
  const block = probeBlock(tag);
  const userNodes = normalizeConversationForExport([
    { role: 'user', content: [block] },
  ]);
  const userMessage = userNodes.find((n) => n.kind === 'user-message');
  const attachment =
    userMessage?.kind === 'user-message'
      ? userMessage.parts.find((p) => p.type === 'attachment')
      : undefined;
  if (attachment?.type === 'attachment') return attachment.attachmentType;

  const assistantNodes = normalizeConversationForExport([
    { role: 'assistant', content: [block] },
  ]);
  if (assistantNodes.some((n) => n.kind === 'tool-call')) return 'tool_use';
  if (assistantNodes.some((n) => n.kind === 'tool-result')) {
    return 'tool_result';
  }
  if (assistantNodes.length === 0) return 'thinking';
  return undefined;
}

describe('CONVERSATION_BLOCK_TYPES switch parity', () => {
  it('the test table covers every CONVERSATION_BLOCK_TYPES member', () => {
    expect(Object.keys(EXPECTED_BUCKET).sort()).toEqual(
      Object.values(CONVERSATION_BLOCK_TYPES).sort(),
    );
  });

  it.each(Object.values(CONVERSATION_BLOCK_TYPES))(
    'both switches classify "%s" into the same bucket',
    (tag) => {
      const expected = EXPECTED_BUCKET[tag];
      expect(expected, `no expected bucket for tag "${tag}"`).toBeDefined();
      expect(formatBucket(tag)).toBe(expected);
      expect(normalizeBucket(tag)).toBe(expected);
    },
  );
});
