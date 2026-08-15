/**
 * Provider-shape normalization: raw provider messages → format-agnostic
 * `ExportNode[]`.
 *
 * Collapses Anthropic, OpenAI (Chat Completions and Response API), Google
 * GenAI, and VS Code language-model message shapes into a single intermediate
 * representation consumed by every chat-export renderer. This module lives
 * alongside the model handlers so provider SDK type changes don't propagate
 * into the command layer.
 *
 * The command-layer export package imports only `normalizeConversationForExport`
 * and the IR types from `@agent/export/schemas` — never `openai/*`,
 * `@agent/modelHandlers/openai/*`, or `@google/genai`.
 */

import { isAssistantMessage } from 'openai/lib/chatCompletionUtils';
import { z } from 'zod';
import { isFunctionToolCall } from '@agent/modelHandlers/openai/functionToolCalls';
import {
  extractTextContentPart,
  isFunctionCallOutputItem,
  isResponseFunctionToolCallItem,
} from '@agent/modelHandlers/openai/responsesShapeGuards';
import {
  classifyProviderMessageBlockType,
  CONVERSATION_BLOCK_TYPES,
} from '@agent/types/ConversationBlockTypes';
import {
  ANTHROPIC_SERVER_TOOL_BLOCK_TYPES,
  extractWebFetchResultFields,
  WebSearchResultEntrySchema,
} from '@agent/types/ServerTools';
import { isObject } from '@utils/core';
import type { Part } from '@google/genai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
} from 'openai/resources/chat/completions';

import type { ExportNode, UserPart } from './schemas';

// ============================================================
// Input schemas (implementation detail — not exported publicly)
// ============================================================

/**
 * One entry inside a `web_search_tool_result` block's `content` array: the
 * provider wire shape of the canonical {@link WebSearchResultEntrySchema},
 * read permissively (`title`/`url` optional on the wire) and tagged with the
 * block's `type` string.
 */
const WebSearchResultItemSchema = WebSearchResultEntrySchema.pick({
  title: true,
  url: true,
})
  .partial()
  .extend({ type: z.string() });

/**
 * Discriminated union of API content blocks across the four provider shapes
 * this module normalizes (Anthropic, OpenAI Chat Completions, OpenAI
 * Response API, Google GenAI — the latter via {@link googlePartToBlocks},
 * which translates Google's field-based `Part` into these type-based
 * blocks). Each variant declares only the fields that provider actually
 * populates for that block kind, so the six consuming functions below can
 * switch/narrow on `type` instead of re-deriving validity with ad hoc
 * optional-field checks.
 */
const ContentBlockSchema = z.discriminatedUnion('type', [
  // Plain text. Anthropic and Google GenAI use 'text'; OpenAI Response API
  // splits it into 'input_text' (user) and 'output_text' (assistant).
  z.object({ type: z.literal('text'), text: z.string().optional() }),
  z.object({ type: z.literal('input_text'), text: z.string().optional() }),
  z.object({ type: z.literal('output_text'), text: z.string().optional() }),

  // Anthropic extended-thinking / Google GenAI thought blocks.
  z.object({
    type: z.literal(CONVERSATION_BLOCK_TYPES.thinking),
    thinking: z.string().optional(),
  }),
  z.object({ type: z.literal(CONVERSATION_BLOCK_TYPES.redactedThinking) }),

  // Tool call / tool result — shared by Anthropic, Google GenAI, and the
  // VS Code language-model bridge (see normalizeContentBlock).
  z.object({
    type: z.literal(CONVERSATION_BLOCK_TYPES.toolUse),
    name: z.string().optional(),
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal(CONVERSATION_BLOCK_TYPES.toolResult),
    content: z.unknown().optional(),
  }),

  // Attachment markers: Anthropic ('image'/'document'), OpenAI Response API
  // ('input_image'/'input_file'), OpenAI Chat Completions ('image_url'/
  // 'file'). None of these carry fields this module reads — only `type`
  // decides which attachment kind to render.
  z.object({ type: z.literal(CONVERSATION_BLOCK_TYPES.image) }),
  z.object({ type: z.literal(CONVERSATION_BLOCK_TYPES.inputImage) }),
  z.object({ type: z.literal(CONVERSATION_BLOCK_TYPES.imageUrl) }),
  z.object({ type: z.literal(CONVERSATION_BLOCK_TYPES.document) }),
  z.object({ type: z.literal(CONVERSATION_BLOCK_TYPES.inputFile) }),
  z.object({ type: z.literal(CONVERSATION_BLOCK_TYPES.file) }),

  // Anthropic server-side tool blocks (the provider executes these, not a
  // local tool handler).
  z.object({
    type: z.literal(ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.serverToolUse),
    name: z.string().optional(),
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal(ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webSearchToolResult),
    content: z.array(WebSearchResultItemSchema).optional(),
  }),
  // `extractWebFetchResultFields` reads its fields off the raw block itself
  // (it accepts `unknown`), not off this schema's inferred type, so this
  // variant only declares the discriminant. `looseObject` (not `object`)
  // documents that undeclared fields are intentionally read elsewhere —
  // and keeps that true if runtime `.parse()` is ever added to this schema
  // (currently it isn't; see the module-level type-derivation-only note).
  z.looseObject({
    type: z.literal(ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webFetchToolResult),
  }),
]);
type ContentBlock = z.infer<typeof ContentBlockSchema>;

const ConversationMessageSchema = z.looseObject({
  role: z.string().optional(),
  content: z
    .union([z.string(), z.array(ContentBlockSchema), z.unknown()])
    .optional(),
  // Google GenAI uses `parts` instead of `content`
  parts: z.array(z.unknown()).optional(),
  // OpenAI Chat Completions: tool_calls on assistant messages
  tool_calls: z.array(z.unknown()).optional(),
});
type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

// ============================================================
// Helpers
// ============================================================

/** Pretty-print a non-string value for display inside an export block. */
function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function extractBlocks(msg: ConversationMessage): ContentBlock[] {
  // Google GenAI: field-based Parts → type-based ContentBlocks
  if (Array.isArray(msg.parts)) {
    return (msg.parts as Part[]).flatMap(googlePartToBlocks);
  }

  if (typeof msg.content === 'string') {
    return [{ type: 'text', text: msg.content }];
  }
  if (Array.isArray(msg.content)) {
    return msg.content.flatMap(normalizeContentBlock);
  }
  if (msg.content != null) {
    return [{ type: 'text', text: prettyJson(msg.content) }];
  }
  return [];
}

/** Convert host-neutral VS Code language-model parts to the shared block form. */
function normalizeContentBlock(block: unknown): ContentBlock[] {
  if (!isObject(block)) return [];
  switch (block.kind) {
    case 'text':
      return [
        {
          type: 'text',
          text: typeof block.text === 'string' ? block.text : undefined,
        },
      ];
    case 'toolCall':
      return [
        {
          type: 'tool_use',
          name: typeof block.name === 'string' ? block.name : undefined,
          input: block.input,
        },
      ];
    case 'toolResult':
      return [{ type: 'tool_result', content: block.text }];
    default:
      return [block as ContentBlock];
  }
}

/** Convert a Google GenAI Part (field-based discrimination) to type-based ContentBlock(s). */
function googlePartToBlocks(part: Part): ContentBlock[] {
  // Google GenAI: thought is a boolean flag; the actual text is in part.text.
  // Must check before the plain text branch to avoid exposing thinking as assistant text.
  if (part.thought === true && typeof part.text === 'string') {
    return [{ type: 'thinking', thinking: part.text }];
  }
  if (typeof part.text === 'string') {
    return [{ type: 'text', text: part.text }];
  }
  if (part.functionCall && typeof part.functionCall === 'object') {
    const fc = part.functionCall;
    return [
      {
        type: 'tool_use',
        name: fc.name ?? 'unknown',
        input: fc.args ?? {},
      },
    ];
  }
  if (part.functionResponse && typeof part.functionResponse === 'object') {
    const fr = part.functionResponse;
    return [
      {
        type: 'tool_result',
        content:
          typeof fr.response === 'string'
            ? fr.response
            : prettyJson(fr.response ?? ''),
      },
    ];
  }
  // Google GenAI: inline bytes or URI-based file data (uploads over the inline
  // threshold). Both expose the media type the same way.
  const blob = part.inlineData ?? part.fileData;
  if (blob && typeof blob === 'object') {
    const { mimeType } = blob as { mimeType?: string };
    return mimeType?.startsWith('image/')
      ? [{ type: 'image' }]
      : [{ type: 'document' }];
  }
  return [];
}

function blocksToUserParts(blocks: ContentBlock[]): UserPart[] {
  const parts: UserPart[] = [];
  for (const b of blocks) {
    // Anthropic: 'text', OpenAI Response API: 'input_text'. Text tags stay
    // per-literal (user text is 'text'/'input_text' here but assistant text
    // is 'text'/'output_text' in `assistantBlockToNode`), so they are not in
    // the shared classifier — see `@agent/types/ConversationBlockTypes`.
    if (b.type === 'text' || b.type === 'input_text') {
      if (b.text) parts.push({ type: 'text', text: b.text });
      continue;
    }
    switch (classifyProviderMessageBlockType(b.type)) {
      case 'image-attachment':
        parts.push({ type: 'attachment', attachmentType: 'image' });
        break;
      case 'document-attachment':
        parts.push({ type: 'attachment', attachmentType: 'document' });
        break;
      default:
        break;
    }
  }
  return parts;
}

function extractToolResultText(block: ContentBlock): string | undefined {
  // Anthropic: 'text', OpenAI Response API: 'input_text'
  if (block.type === 'text' || block.type === 'input_text') {
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
// `ExportNode` here vs. a truncated marker string there).
function assistantBlockToNode(block: ContentBlock): ExportNode | null {
  // Anthropic: 'text', OpenAI Response API: 'output_text'. Text tags stay
  // per-literal (see `blocksToUserParts` for the user-side split).
  if (block.type === 'text' || block.type === 'output_text') {
    return block.text?.trim()
      ? { kind: 'assistant-text', text: block.text }
      : null;
  }

  switch (classifyProviderMessageBlockType(block.type)) {
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
        text:
          typeof toolResult.content === 'string'
            ? toolResult.content
            : prettyJson(toolResult.content ?? ''),
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

    default:
      return null;
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Normalize raw provider messages into a format-agnostic {@link ExportNode[]}.
 *
 * Handles Anthropic, OpenAI (Chat Completions and Response API), Google GenAI,
 * and VS Code language-model message shapes. The resulting nodes are consumed
 * by every format renderer (markdown, LaTeX, HTML).
 */
export function normalizeConversationForExport(
  messages: unknown[],
): ExportNode[] {
  const nodes: ExportNode[] = [];
  let lastAssistantHadToolUse = false;

  for (const raw of messages) {
    if (!isObject(raw)) continue;
    const item = raw;

    // OpenAI Response API: top-level function_call items (not wrapped in a message)
    if (isResponseFunctionToolCallItem(item)) {
      const args =
        typeof item.arguments === 'string'
          ? item.arguments
          : prettyJson(item.arguments ?? {});
      const name = item.name ?? 'unknown';
      nodes.push({ kind: 'tool-call', name, input: args });
      lastAssistantHadToolUse = true;
      continue;
    }

    // OpenAI Response API: top-level function_call_output items.
    // output can be a string OR an array of input_text/input_file/input_image parts.
    if (isFunctionCallOutputItem(item)) {
      const output = item.output;
      if (Array.isArray(output)) {
        const textParts = output.flatMap((part) => {
          const text = extractTextContentPart(part);
          if (text !== undefined) return [text];
          if (part.type === 'input_image') return ['[image attachment]'];
          if (part.type === 'input_file') return ['[file attachment]'];
          return [];
        });
        if (textParts.length) {
          nodes.push({ kind: 'tool-result', text: textParts.join('\n') });
        }
      } else {
        const outputText =
          typeof output === 'string' ? output : prettyJson(output ?? '');
        nodes.push({ kind: 'tool-result', text: outputText });
      }
      lastAssistantHadToolUse = false;
      continue;
    }

    const msg = item as ConversationMessage;
    const role = msg.role ?? 'unknown';
    const blocks = extractBlocks(msg);

    if (role === 'user') {
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

    // Google GenAI uses 'model' role instead of 'assistant'
    if (role === 'assistant' || role === 'model') {
      lastAssistantHadToolUse = false;
      for (const block of blocks) {
        const node = assistantBlockToNode(block);
        if (node) {
          if (node.kind === 'tool-call') lastAssistantHadToolUse = true;
          nodes.push(node);
        }
      }

      // OpenAI Chat Completions: tool_calls array on assistant messages
      for (const tc of getAssistantToolCalls(item)) {
        const fn = tc.function;
        if (fn?.name) {
          nodes.push({
            kind: 'tool-call',
            name: fn.name,
            input: fn.arguments ?? '{}',
          });
          lastAssistantHadToolUse = true;
        }
      }
      continue;
    }

    // OpenAI Chat Completions tool role
    if (role === 'tool') {
      const text =
        typeof msg.content === 'string' ? msg.content : prettyJson(msg.content);
      nodes.push({ kind: 'tool-result', text });
      lastAssistantHadToolUse = false;
    }
  }

  return nodes;
}

function getAssistantToolCalls(
  item: unknown,
): ChatCompletionMessageFunctionToolCall[] {
  const message = item as ChatCompletionMessageParam;
  if (!isAssistantMessage(message) || !Array.isArray(message.tool_calls)) {
    return [];
  }

  // Skip non-function entries while preserving valid calls.
  return message.tool_calls.filter(isFunctionToolCall);
}
