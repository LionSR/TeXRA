// Stateless content guards and value-object builders for the OpenAI Responses
// API. These construct and narrow the SDK's input/output content shapes and
// carry no handler state, so they are shared by the handler and the
// file-upload helpers.

import type {
  EasyInputMessage,
  ResponseInputContent,
  ResponseInputFile,
  ResponseInputItem,
  ResponseOutputMessage,
} from 'openai/resources/responses/responses';

import { extractTextContentPart } from './responsesShapeGuards';

/** Build an `input_text` content part. */
export function createInputText(text: string): ResponseInputContent {
  return { type: 'input_text', text };
}

/** Type guard for message items (input or output) with string/array content. */
export function isMessageItem(
  item?: ResponseInputItem,
): item is EasyInputMessage | ResponseInputItem.Message {
  if (!item || typeof item !== 'object') return false;
  if (!('role' in item) || typeof item.role !== 'string') return false;
  if (
    'type' in item &&
    typeof item.type === 'string' &&
    item.type !== 'message'
  ) {
    return false;
  }
  if (!('content' in item)) return false;
  const { content } = item;
  return typeof content === 'string' || Array.isArray(content);
}

/** Type guard for assistant text messages. */
export function isAssistantTextMessage(
  item?: ResponseInputItem,
): item is EasyInputMessage | ResponseOutputMessage {
  return (
    item?.type === 'message' &&
    item.role === 'assistant' &&
    (typeof item.content === 'string' || Array.isArray(item.content))
  );
}

/**
 * Flatten Responses message content (a string, or an array of text parts) to
 * plain text. Non-text parts contribute nothing. Array parts are joined with
 * `separator` ('' for in-line text, '\n' for row-per-message shapes); a
 * string content is returned verbatim regardless of separator.
 */
export function contentToText(content: unknown, separator = '\n'): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => extractTextContentPart(part) ?? '')
    .filter((text) => text.length > 0)
    .join(separator);
}

/** Whether a completed Responses payload already carries assistant text. */
export function hasResponseOutputText(response: {
  readonly output_text?: unknown;
  readonly output?: unknown;
}): boolean {
  if (
    typeof response.output_text === 'string' &&
    response.output_text.trim().length > 0
  ) {
    return true;
  }
  if (!Array.isArray(response.output)) return false;

  return response.output.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as {
      readonly type?: unknown;
      readonly role?: unknown;
      readonly content?: unknown;
    };
    if (candidate.type !== 'message') return false;
    if (candidate.role != null && candidate.role !== 'assistant') return false;
    // Inlined from a former single-caller helper: this check decides whether
    // compaction text is injected, so it stays auditable as one unit.
    const { content } = candidate;
    if (typeof content === 'string') return content.trim().length > 0;
    if (!Array.isArray(content)) return false;
    return content.some(
      (part) => (extractTextContentPart(part)?.trim().length ?? 0) > 0,
    );
  });
}

/** Type guard for input_file content parts. */
export function isInputFileContent(
  content: ResponseInputContent,
): content is ResponseInputFile {
  return content.type === 'input_file';
}
