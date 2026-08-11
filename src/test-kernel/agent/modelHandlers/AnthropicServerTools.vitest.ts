import { describe, expect, it } from 'vitest';

import {
  stripOrphanedServerToolUse,
  extractAnthropicServerToolData,
  buildAnthropicAssistantContent,
} from '@agent/modelHandlers/anthropic/anthropicServerTools';
import type {
  BetaContentBlock,
  BetaMessage,
} from '@anthropic-ai/sdk/resources/beta/messages';

// Minimal block fixtures. The production guards discriminate on `type`, so these
// runtime shapes are sufficient; cast through unknown to satisfy the SDK types.
const textBlock = { type: 'text', text: 'hello', citations: null };
const thinkingBlock = { type: 'thinking', thinking: 'hmm', signature: 'sig' };

const serverUse = (id: string, name: 'web_search' | 'web_fetch') => ({
  type: 'server_tool_use',
  id,
  name,
  input: {},
});
const searchResult = (toolUseId: string) => ({
  type: 'web_search_tool_result',
  tool_use_id: toolUseId,
  content: [],
});
const fetchResult = (toolUseId: string) => ({
  type: 'web_fetch_tool_result',
  tool_use_id: toolUseId,
  content: { type: 'web_fetch_result', url: 'https://x', content: {} },
});

const asBlocks = (blocks: unknown[]): BetaContentBlock[] =>
  blocks as BetaContentBlock[];

const asMessage = (blocks: unknown[]): BetaMessage =>
  ({ content: blocks }) as unknown as BetaMessage;

const typesOf = (blocks: unknown[]): string[] =>
  blocks.map((b) => (b as { type: string }).type);

describe('stripOrphanedServerToolUse', () => {
  it('keeps server_tool_use blocks that have a matching result', () => {
    const blocks = asBlocks([
      textBlock,
      serverUse('s1', 'web_search'),
      searchResult('s1'),
      serverUse('f1', 'web_fetch'),
      fetchResult('f1'),
    ]);
    const { kept, orphanedIds } = stripOrphanedServerToolUse(blocks);
    expect(orphanedIds).toEqual([]);
    expect(kept).toHaveLength(5);
  });

  it('drops server_tool_use blocks missing their result and reports the ids', () => {
    const blocks = asBlocks([
      textBlock,
      serverUse('s1', 'web_search'), // orphan: no result
      serverUse('f1', 'web_fetch'),
      fetchResult('f1'),
    ]);
    const { kept, orphanedIds } = stripOrphanedServerToolUse(blocks);
    expect(orphanedIds).toEqual(['s1']);
    expect(typesOf(kept)).toEqual([
      'text',
      'server_tool_use', // f1 kept (paired)
      'web_fetch_tool_result',
    ]);
  });

  it('never strips non-server-tool blocks', () => {
    const blocks = asBlocks([textBlock, thinkingBlock]);
    const { kept, orphanedIds } = stripOrphanedServerToolUse(blocks);
    expect(orphanedIds).toEqual([]);
    expect(kept).toHaveLength(2);
  });
});

describe('extractAnthropicServerToolData', () => {
  it('returns empty results when content is not an array', () => {
    const result = extractAnthropicServerToolData({} as BetaMessage);
    expect(result).toEqual({
      webSearchResults: [],
      webFetchResults: [],
      contentBlocks: [],
    });
  });

  it('keeps only server-tool content and strips orphaned calls', () => {
    const message = asMessage([
      textBlock, // dropped: not server-tool content
      serverUse('s1', 'web_search'),
      searchResult('s1'),
      serverUse('s2', 'web_search'), // orphan
    ]);
    const { contentBlocks } = extractAnthropicServerToolData(message);
    expect(typesOf(contentBlocks)).toEqual([
      'server_tool_use',
      'web_search_tool_result',
    ]);
  });
});

describe('buildAnthropicAssistantContent', () => {
  const logger = { debug: () => {} } as never;

  function buildContent(
    blocks: unknown[],
    supportsPromptCaching: boolean,
  ): unknown[] {
    return buildAnthropicAssistantContent(
      asMessage(blocks),
      { supportsPromptCaching },
      logger,
    );
  }

  it('excludes tool_use blocks and strips orphaned server_tool_use', () => {
    const out = buildContent(
      [
        thinkingBlock,
        textBlock,
        { type: 'tool_use', id: 't1', name: 'edit', input: {} },
        serverUse('s1', 'web_search'), // orphan -> stripped
      ],
      false,
    );
    expect(typesOf(out)).toEqual(['thinking', 'text']);
  });

  it('tags the compaction block with a cache breakpoint when caching is on', () => {
    const out = buildContent(
      [textBlock, { type: 'compaction', content: 'x' }],
      true,
    );
    const compaction = out.find(
      (b) => (b as { type: string }).type === 'compaction',
    ) as { cache_control?: { type: string; ttl?: string } };
    expect(compaction.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('leaves blocks untouched when caching is off', () => {
    const out = buildContent([{ type: 'compaction', content: 'x' }], false);
    expect(
      (out[0] as { cache_control?: unknown }).cache_control,
    ).toBeUndefined();
  });
});
