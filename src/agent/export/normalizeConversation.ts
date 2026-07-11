/**
 * Provider-shape normalization: raw provider messages → format-agnostic
 * `ExportNode[]`.
 *
 * Collapses Anthropic, OpenAI (Chat Completions and Response API), and Google
 * GenAI message shapes into a single intermediate representation consumed by
 * every chat-export renderer. This module lives alongside the model handlers so
 * provider SDK type changes don't propagate into the command layer.
 *
 * The command-layer export package imports only `normalizeConversationForExport`
 * and the IR types from `@agent/export/schemas` — never `openai/*`,
 * `@agent/modelHandlers/openai/*`, or `@google/genai`.
 */

import {
  isAssistantMessage,
  isToolMessage,
} from 'openai/lib/chatCompletionUtils';
import { assertToolCallsAreChatCompletionFunctionToolCalls } from 'openai/lib/parser';
import { z } from 'zod';
import {
  extractTextContentPart,
  isFunctionCallOutputItem,
} from '@agent/modelHandlers/openai/openAIResponseContent';
import { isResponseFunctionToolCallItem } from '@agent/modelHandlers/openai/responseStreamEvents';
import type { Part } from '@google/genai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type {
  ResponseFunctionToolCallItem,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

import type { ExportNode, UserPart } from './schemas';

// ============================================================
// Input schemas (implementation detail — not exported publicly)
// ============================================================

/**
 * Loose schema for API content blocks — accepts many optional fields.
 * Covers Anthropic, OpenAI Chat Completions, and OpenAI Response API formats.
 */
const ContentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  input: z.unknown().optional(),
  content: z.unknown().optional(),
  source: z
    .looseObject({ type: z.string(), media_type: z.string().optional() })
    .optional(),
  query: z.string().optional(),
  search_results: z
    .array(
      z.looseObject({
        title: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  page_content: z.string().optional(),
  // OpenAI Response API fields
  arguments: z.string().optional(),
  output: z.string().optional(),
});
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
    return msg.content as ContentBlock[];
  }
  if (msg.content != null) {
    return [{ type: 'text', text: prettyJson(msg.content) }];
  }
  return [];
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
    return [{ type: mimeType?.startsWith('image/') ? 'image' : 'document' }];
  }
  return [];
}

function blocksToUserParts(blocks: ContentBlock[]): UserPart[] {
  const parts: UserPart[] = [];
  for (const b of blocks) {
    // Anthropic: 'text', OpenAI Response API: 'input_text'
    if ((b.type === 'text' || b.type === 'input_text') && b.text) {
      parts.push({ type: 'text', text: b.text });
    } else if (
      b.type === 'image' ||
      b.type === 'input_image' ||
      b.type === 'image_url'
    ) {
      parts.push({ type: 'attachment', attachmentType: 'image' });
    } else if (
      b.type === 'document' ||
      b.type === 'input_file' ||
      b.type === 'file'
    ) {
      parts.push({ type: 'attachment', attachmentType: 'document' });
    }
  }
  return parts;
}

function extractToolResultText(block: ContentBlock): string | undefined {
  if (block.type === 'tool_result') {
    return typeof block.content === 'string'
      ? block.content
      : prettyJson(block.content);
  }
  // Anthropic: 'text', OpenAI Response API: 'input_text'
  if ((block.type === 'text' || block.type === 'input_text') && block.text) {
    return block.text;
  }
  return undefined;
}

function assistantBlockToNode(block: ContentBlock): ExportNode | null {
  switch (block.type) {
    case 'thinking':
    case 'redacted_thinking':
      return null;

    // Anthropic: 'text', OpenAI Response API: 'output_text'
    case 'text':
    case 'output_text':
      return block.text?.trim()
        ? { kind: 'assistant-text', text: block.text }
        : null;

    case 'tool_use':
      return {
        kind: 'tool-call',
        name: block.name ?? 'unknown',
        input: prettyJson(block.input ?? {}),
      };

    case 'tool_result':
      return {
        kind: 'tool-result',
        text:
          typeof block.content === 'string'
            ? block.content
            : prettyJson(block.content ?? ''),
      };

    // Anthropic server-side tool blocks (the provider executes these, not a
    // local tool handler). This vocabulary must stay in sync with the
    // `formatConversationBlock` switch in `@agent/storage/conversationFormat`
    // — both classify the same three live Anthropic block types emitted by
    // `AnthropicStreamHandler` (`server_tool_use`, `web_search_tool_result`,
    // `web_fetch_tool_result`), just into different output shapes (a
    // structured `ExportNode` here vs. a truncated marker string there).
    case 'server_tool_use':
      if (block.name === 'web_search') {
        const query =
          block.input && typeof block.input === 'object'
            ? (block.input as { query?: string }).query
            : undefined;
        return query ? { kind: 'web-search', query } : null;
      }
      return null;

    case 'web_search_tool_result': {
      if (!Array.isArray(block.content)) return null;
      const results = (block.content as ContentBlock[])
        .filter((e) => e.type === 'web_search_result' && e.url)
        .map((e) => ({ title: e.title ?? e.url!, url: e.url! }));
      return results.length ? { kind: 'web-search-results', results } : null;
    }

    case 'web_fetch_tool_result':
      return {
        kind: 'web-fetch',
        url: block.url,
        title: block.title,
        content: block.page_content,
      };

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
 * Handles Anthropic, OpenAI (Chat Completions and Response API), and Google
 * GenAI message shapes. The resulting nodes are consumed by every format
 * renderer (markdown, LaTeX, HTML).
 */
export function normalizeConversationForExport(
  messages: unknown[],
): ExportNode[] {
  const nodes: ExportNode[] = [];
  let lastAssistantHadToolUse = false;

  for (const raw of messages) {
    const item = asObject(raw);
    if (!item) {
      continue;
    }

    // OpenAI Response API: top-level function_call items (not wrapped in a message)
    const responseToolCall = asCandidate<ResponseFunctionToolCallItem>(item);
    if (isResponseFunctionToolCallItem(responseToolCall)) {
      const args =
        typeof responseToolCall.arguments === 'string'
          ? responseToolCall.arguments
          : prettyJson(responseToolCall.arguments ?? {});
      const name = responseToolCall.name ?? 'unknown';
      nodes.push({ kind: 'tool-call', name, input: args });
      lastAssistantHadToolUse = true;
      continue;
    }

    // OpenAI Response API: top-level function_call_output items.
    // output can be a string OR an array of input_text/input_file/input_image parts.
    const responseInputItem = asCandidate<ResponseInputItem>(item);
    if (isFunctionCallOutputItem(responseInputItem)) {
      const output = responseInputItem.output;
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
    const openaiMsg = asCandidate<ChatCompletionMessageParam>(item);
    if (role === 'tool' || isToolMessage(openaiMsg)) {
      const text =
        typeof openaiMsg.content === 'string'
          ? openaiMsg.content
          : prettyJson(openaiMsg.content);
      nodes.push({ kind: 'tool-result', text });
      lastAssistantHadToolUse = false;
    }
  }

  return nodes;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Bridge a raw, provider-shape-unknown item into one of the candidate SDK
 * item types so a real type-guard function (e.g. `isResponseFunctionToolCallItem`)
 * can check its `type` discriminant. `item` may legitimately be any of
 * Anthropic's, OpenAI's, or Google's shapes — the guard, not this cast, is
 * what verifies it before the caller trusts the narrowed fields.
 */
function asCandidate<T>(item: Record<string, unknown>): T {
  return item as unknown as T;
}

function getAssistantToolCalls(
  item: unknown,
): ChatCompletionMessageFunctionToolCall[] {
  const message = item as ChatCompletionMessageParam;
  if (!isAssistantMessage(message) || !Array.isArray(message.tool_calls)) {
    return [];
  }

  try {
    const candidate = message.tool_calls as ChatCompletionMessageToolCall[];
    assertToolCallsAreChatCompletionFunctionToolCalls(candidate);
    return candidate;
  } catch {
    const functionToolCalls: ChatCompletionMessageFunctionToolCall[] = [];
    for (const toolCall of message.tool_calls) {
      const candidate: ChatCompletionMessageToolCall[] = [toolCall];
      try {
        assertToolCallsAreChatCompletionFunctionToolCalls(candidate);
        functionToolCalls.push(candidate[0]);
      } catch {
        // Skip non-function or malformed entries while preserving valid calls.
      }
    }
    return functionToolCalls;
  }
}
