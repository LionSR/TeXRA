// Server-tool (web_search / web_fetch) content handling for Anthropic responses.
//
// Anthropic returns web_search / web_fetch results as paired blocks: a
// `server_tool_use` call followed by a `*_tool_result`. The API rejects any
// follow-up message that echoes a `server_tool_use` without its matching
// result block, so orphaned calls must be stripped before the assistant turn is
// re-sent for context. Both the display-extraction path and the
// context-continuation path need this stripping, so it lives here in one place.

// Type imports - agent
import type { AgentTrace } from '@agent/trace';

// Local imports - model handlers
import { LONG_CACHE_CONTROL } from './anthropicContextManagement';
import {
  extractAnthropicWebFetchResults,
  extractAnthropicWebSearchResults,
  isAnthropicServerToolContent,
  isAnthropicServerToolUse,
  isAnthropicWebFetchResult,
  isAnthropicWebSearchResult,
  type ServerToolExtractionResult,
} from '../types/ServerToolTypes';

// Type imports - Anthropic SDK
import type {
  BetaContentBlock,
  BetaMessage,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebFetchToolResultBlock,
} from '@anthropic-ai/sdk/resources/messages';

/**
 * Partitions content blocks, dropping `server_tool_use` blocks (web_search /
 * web_fetch) that have no matching result block. Returns the kept blocks plus
 * the IDs of the stripped orphans (for diagnostics).
 */
export function stripOrphanedServerToolUse<T extends BetaContentBlock>(
  blocks: readonly T[],
): { kept: T[]; orphanedIds: string[] } {
  const searchResultIds = new Set(
    blocks.filter(isAnthropicWebSearchResult).map((b) => b.tool_use_id),
  );
  const fetchResultIds = new Set(
    blocks.filter(isAnthropicWebFetchResult).map((b) => b.tool_use_id),
  );

  const orphanedIds: string[] = [];
  const kept = blocks.filter((block) => {
    if (!isAnthropicServerToolUse(block)) return true;
    if (block.name === 'web_search') {
      if (searchResultIds.has(block.id)) return true;
      orphanedIds.push(block.id);
      return false;
    }
    if (block.name === 'web_fetch') {
      if (fetchResultIds.has(block.id)) return true;
      orphanedIds.push(block.id);
      return false;
    }
    return true;
  });

  return { kept, orphanedIds };
}

/**
 * Extracts server-tool data from a response in a single pass: normalized
 * web-search / web-fetch results for display, plus the raw server-tool content
 * blocks (orphaned `server_tool_use` blocks stripped) for context continuation.
 */
export function extractAnthropicServerToolData(
  responseObject: BetaMessage,
): ServerToolExtractionResult {
  if (!Array.isArray(responseObject?.content)) {
    return { webSearchResults: [], webFetchResults: [], contentBlocks: [] };
  }

  // Filter for server tool content (server_tool_use, web_search_tool_result,
  // web_fetch_tool_result). Cast needed because BetaContentBlock has slightly
  // different types than the regular API.
  const serverToolBlocks = responseObject.content.filter(
    isAnthropicServerToolContent,
  ) as (ServerToolUseBlock | WebSearchToolResultBlock | WebFetchToolResultBlock)[];

  const { kept: contentBlocks } = stripOrphanedServerToolUse(serverToolBlocks);

  return {
    webSearchResults: extractAnthropicWebSearchResults(responseObject.content),
    webFetchResults: extractAnthropicWebFetchResults(responseObject.content),
    contentBlocks,
  };
}

/**
 * Builds the assistant content blocks to replay for context continuation,
 * excluding `tool_use` blocks and stripping orphaned `server_tool_use` blocks.
 * Preserves thinking, text, server_tool_use, and tool-result blocks. When
 * prompt caching is supported, the compaction block is tagged with a 1h cache
 * breakpoint.
 */
export function buildAnthropicAssistantContent(
  responseObject: BetaMessage,
  options: { supportsPromptCaching: boolean },
  logger: AgentTrace,
): unknown[] {
  if (!Array.isArray(responseObject?.content)) {
    return [];
  }

  const nonToolUse = responseObject.content.filter(
    (block) => block.type !== 'tool_use',
  );
  const { kept, orphanedIds } = stripOrphanedServerToolUse(nonToolUse);

  if (orphanedIds.length > 0) {
    logger.debug(
      `Stripping ${orphanedIds.length} orphaned server_tool_use block(s) without matching result: ${orphanedIds.join(', ')}. ` +
        `Response content types: [${responseObject.content.map((b) => b.type).join(', ')}]`,
    );
  }

  if (!options.supportsPromptCaching) {
    return kept;
  }

  return kept.map((block) =>
    block.type === 'compaction'
      ? { ...block, cache_control: LONG_CACHE_CONTROL }
      : block,
  );
}
