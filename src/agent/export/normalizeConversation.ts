/**
 * Conversation normalization: completed-run messages → format-agnostic
 * `ExportNode[]`.
 *
 * The input is the Anthropic-style `{role, content}` vocabulary that
 * `readCompletedRunConversation` (`@transcript/completedRunArchive`) emits;
 * this module collapses it into a single intermediate representation consumed
 * by every chat-export renderer.
 *
 * The command-layer export package imports only `normalizeConversationForExport`
 * and the IR types from `@agent/export/schemas`.
 */

import {
  classifyProviderMessageBlockType,
  CONVERSATION_BLOCK_TYPES,
  type ProviderMessageBlockCategory,
} from '@agent/types/ConversationBlockTypes';
import {
  ANTHROPIC_SERVER_TOOL_BLOCK_TYPES,
  extractWebFetchResultFields,
  type WebSearchResult,
} from '@agent/types/ServerTools';
import { assertNever, isObject } from '@utils/core';

import type { ExportNode, UserPart } from './schemas';

// ============================================================
// Input types (implementation detail — not exported publicly)
// ============================================================

/**
 * One entry inside a `web_search_tool_result` block's `content` array: the
 * provider wire shape of the canonical {@link WebSearchResult},
 * read permissively (`title`/`url` optional on the wire) and tagged with the
 * block's `type` string.
 */
type WebSearchResultItem = Partial<
  Pick<WebSearchResult['results'][number], 'title' | 'url'>
> & { type: string };

/**
 * Discriminated union of the content blocks `readCompletedRunConversation`
 * emits. Each variant declares only the fields this module reads for that
 * block kind. Existing runtime guards narrow the raw values; this union gives
 * the consumers below exhaustive `type`-based narrowing afterward.
 */
type ContentBlock =
  | { type: 'text'; text?: string }
  | {
      type: typeof CONVERSATION_BLOCK_TYPES.thinking;
      thinking?: string;
    }
  | {
      type: typeof CONVERSATION_BLOCK_TYPES.toolUse;
      name?: string;
      input?: unknown;
    }
  | {
      type: typeof CONVERSATION_BLOCK_TYPES.toolResult;
      content?: unknown;
    }

  // Attachment markers carry no fields this module reads — only `type`
  // decides which attachment kind to render.
  | { type: typeof CONVERSATION_BLOCK_TYPES.image }
  | { type: typeof CONVERSATION_BLOCK_TYPES.document }

  // Anthropic server-side tool blocks (the provider executes these, not a
  // local tool handler).
  | {
      type: typeof ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.serverToolUse;
      name?: string;
      input?: unknown;
    }
  | {
      type: typeof ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webSearchToolResult;
      content?: WebSearchResultItem[];
    }
  // `extractWebFetchResultFields` reads its fields off the raw block itself
  // (it accepts `unknown`), so this variant only declares the discriminant.
  | {
      type: typeof ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webFetchToolResult;
      [key: string]: unknown;
    };

interface ConversationMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

// ============================================================
// Helpers
// ============================================================

/** Pretty-print a non-string value for display inside an export block. */
function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Render a tool-result payload as display text: strings pass through. */
function toolResultContentText(content: unknown): string {
  return typeof content === 'string' ? content : prettyJson(content ?? '');
}

function extractBlocks(msg: ConversationMessage): ContentBlock[] {
  if (typeof msg.content === 'string') {
    return [{ type: 'text', text: msg.content }];
  }
  if (Array.isArray(msg.content)) {
    return msg.content.filter(isObject) as ContentBlock[];
  }
  if (msg.content != null) {
    return [{ type: 'text', text: prettyJson(msg.content) }];
  }
  return [];
}

function blocksToUserParts(blocks: ContentBlock[]): UserPart[] {
  const parts: UserPart[] = [];
  for (const b of blocks) {
    // Text stays per-literal, outside the shared classifier — see
    // `@agent/types/ConversationBlockTypes`.
    if (b.type === 'text') {
      if (b.text) parts.push({ type: 'text', text: b.text });
      continue;
    }
    const category: ProviderMessageBlockCategory | undefined =
      classifyProviderMessageBlockType(b.type);
    switch (category) {
      case 'image-attachment':
        parts.push({ type: 'attachment', attachmentType: 'image' });
        break;
      case 'document-attachment':
        parts.push({ type: 'attachment', attachmentType: 'document' });
        break;
      // Every other recognized block carries no user part — thinking and the
      // tool blocks are assistant-side. A tool-result tag only reaches this
      // switch inside a plain user message (results answering an assistant
      // tool use go through `extractToolResultText` instead), so it is
      // dropped here; `undefined` covers unrecognized tags.
      case 'thinking':
      case 'tool-use':
      case 'tool-result':
      case 'server-tool-use':
      case 'web-search-tool-result':
      case 'web-fetch-tool-result':
      case undefined:
        break;
      default:
        assertNever(category, 'Unhandled provider message block category');
    }
  }
  return parts;
}

function extractToolResultText(block: ContentBlock): string | undefined {
  if (block.type === 'text') {
    return block.text || undefined;
  }
  if (classifyProviderMessageBlockType(block.type) !== 'tool-result') {
    return undefined;
  }
  const toolResult =
    asClassifiedBlock<typeof CONVERSATION_BLOCK_TYPES.toolResult>(block);
  return typeof toolResult.content === 'string'
    ? toolResult.content
    : prettyJson(toolResult.content);
}

/**
 * Re-narrow a `ContentBlock` to the variant behind a tag the shared
 * classifier recognized. The classifier establishes tag → category; inside a
 * category case the tag is known, but TypeScript cannot propagate that back
 * to the block's variant, so each case re-anchors it here.
 */
function asClassifiedBlock<T extends ContentBlock['type']>(
  block: ContentBlock,
): Extract<ContentBlock, { type: T }> {
  return block as Extract<ContentBlock, { type: T }>;
}

// Non-text tag classification is shared with `formatConversationBlock` in
// `@agent/storage/conversationFormat` via `classifyProviderMessageBlockType`
// (`@agent/types/ConversationBlockTypes`) — one switch recognizes the tags;
// each module maps the category into its own output shape (a structured
// `ExportNode` here vs. a truncated marker string there). Both category
// switches in this module are exhaustive over `ProviderMessageBlockCategory`
// (`default: assertNever`), so a category added to the classifier fails at
// compile time here instead of silently dropping the block.
function assistantBlockToNode(block: ContentBlock): ExportNode | null {
  if (block.type === 'text') {
    return block.text?.trim()
      ? { kind: 'assistant-text', text: block.text }
      : null;
  }

  const category: ProviderMessageBlockCategory | undefined =
    classifyProviderMessageBlockType(block.type);
  switch (category) {
    case 'thinking':
      return null;

    case 'tool-use': {
      const toolUse =
        asClassifiedBlock<typeof CONVERSATION_BLOCK_TYPES.toolUse>(block);
      return {
        kind: 'tool-call',
        name: toolUse.name ?? 'unknown',
        input: prettyJson(toolUse.input ?? {}),
      };
    }

    case 'tool-result': {
      const toolResult =
        asClassifiedBlock<typeof CONVERSATION_BLOCK_TYPES.toolResult>(block);
      return {
        kind: 'tool-result',
        text: toolResultContentText(toolResult.content),
      };
    }

    // Anthropic server-side tool blocks (the provider executes these, not a
    // local tool handler).
    case 'server-tool-use': {
      const serverToolUse =
        asClassifiedBlock<
          typeof ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.serverToolUse
        >(block);
      if (serverToolUse.name === 'web_search') {
        const query =
          serverToolUse.input && typeof serverToolUse.input === 'object'
            ? (serverToolUse.input as { query?: string }).query
            : undefined;
        return query ? { kind: 'web-search', query } : null;
      }
      return null;
    }

    case 'web-search-tool-result': {
      const webSearchResult =
        asClassifiedBlock<
          typeof ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webSearchToolResult
        >(block);
      if (!Array.isArray(webSearchResult.content)) return null;
      const results = webSearchResult.content
        .filter((e) => e.type === 'web_search_result' && e.url)
        .map((e) => ({ title: e.title ?? e.url!, url: e.url! }));
      return results.length ? { kind: 'web-search-results', results } : null;
    }

    case 'web-fetch-tool-result': {
      const result = extractWebFetchResultFields(block);
      if (!result) return null;
      return {
        kind: 'web-fetch',
        ...result,
      };
    }

    // Attachment blocks belong to user messages (`blocksToUserParts`); on the
    // assistant side they — like unrecognized tags (`undefined`) — produce no
    // export node.
    case 'image-attachment':
    case 'document-attachment':
    case undefined:
      return null;
    default:
      return assertNever(category, 'Unhandled provider message block category');
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Normalize completed-run messages into a format-agnostic
 * {@link ExportNode[]}. The resulting nodes are consumed by every format spec
 * (markdown, LaTeX); the HTML export path uses `assembleTrace` instead.
 */
export function normalizeConversationForExport(
  messages: unknown[],
): ExportNode[] {
  const nodes: ExportNode[] = [];
  let lastAssistantHadToolUse = false;

  for (const raw of messages) {
    if (!isObject(raw)) continue;
    const msg = raw as ConversationMessage;
    const blocks = extractBlocks(msg);

    if (msg.role === 'user') {
      if (lastAssistantHadToolUse) {
        for (const block of blocks) {
          const text = extractToolResultText(block);
          if (text) nodes.push({ kind: 'tool-result', text });
        }
        lastAssistantHadToolUse = false;
      } else {
        const parts = blocksToUserParts(blocks);
        if (parts.length) nodes.push({ kind: 'user-message', parts });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      lastAssistantHadToolUse = false;
      for (const block of blocks) {
        const node = assistantBlockToNode(block);
        if (node) {
          if (node.kind === 'tool-call') lastAssistantHadToolUse = true;
          nodes.push(node);
        }
      }
    }
  }

  return nodes;
}
