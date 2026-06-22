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
import { z } from 'zod';

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
    return [{ type: 'text', text: JSON.stringify(msg.content, null, 2) }];
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
            : JSON.stringify(fr.response ?? '', null, 2),
      },
    ];
  }
  if (part.inlineData && typeof part.inlineData === 'object') {
    const data = part.inlineData as { mimeType?: string };
    return [
      { type: data.mimeType?.startsWith('image/') ? 'image' : 'document' },
    ];
  }
  // Google GenAI: URI-based file data (uploaded files over the inline threshold)
  if (part.fileData && typeof part.fileData === 'object') {
    const data = part.fileData as { mimeType?: string };
    return [
      { type: data.mimeType?.startsWith('image/') ? 'image' : 'document' },
    ];
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
      : JSON.stringify(block.content, null, 2);
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
        input: JSON.stringify(block.input ?? {}, null, 2),
      };

    // Tool result blocks: Anthropic tool_result + server-side code execution results
    case 'tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
      return {
        kind: 'tool-result',
        text:
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '', null, 2),
      };

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
    const responseToolCall = item as unknown as
      | ResponseFunctionToolCallItem
      | undefined;
    if (isResponseFunctionToolCallItem(responseToolCall)) {
      const args =
        typeof responseToolCall.arguments === 'string'
          ? responseToolCall.arguments
          : JSON.stringify(responseToolCall.arguments ?? {}, null, 2);
      const name = responseToolCall.name ?? 'unknown';
      nodes.push({ kind: 'tool-call', name, input: args });
      lastAssistantHadToolUse = true;
      continue;
    }

    // OpenAI Response API: top-level function_call_output items.
    // output can be a string OR an array of input_text/input_file/input_image parts.
    const responseInputItem = item as unknown as ResponseInputItem | undefined;
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
          typeof output === 'string'
            ? output
            : JSON.stringify(output ?? '', null, 2);
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
    const openaiMsg = item as unknown as ChatCompletionMessageParam;
    if (role === 'tool' || isToolMessage(openaiMsg)) {
      const text =
        typeof openaiMsg.content === 'string'
          ? openaiMsg.content
          : JSON.stringify(openaiMsg.content, null, 2);
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
