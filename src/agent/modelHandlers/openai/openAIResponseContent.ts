// Stateless content guards and value-object builders for the OpenAI Responses
// API. These construct and narrow the SDK's input/output content shapes and
// carry no handler state, so they are shared by the handler and the
// file-upload helpers.

import type {
  EasyInputMessage,
  ResponseInputContent,
  ResponseInputFile,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputMessage,
} from 'openai/resources/responses/responses';

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

/** Extract the text from an input_text/output_text content part, if it is one. */
export function extractTextContentPart(part: unknown): string | undefined {
  if (!part || typeof part !== 'object') return undefined;
  const candidate = part as { type?: unknown; text?: unknown };
  return (candidate.type === 'input_text' ||
    candidate.type === 'output_text') &&
    typeof candidate.text === 'string'
    ? candidate.text
    : undefined;
}

/** Type guard for ResponseOutputMessage items from the SDK. */
export function isOutputMessage(
  item: ResponseOutputItem,
): item is ResponseOutputMessage {
  return item.type === 'message';
}

/** Type guard for input_file content parts. */
export function isInputFileContent(
  content: ResponseInputContent,
): content is ResponseInputFile {
  return content.type === 'input_file';
}
