// Stateless shape guards for OpenAI Responses API payloads.
//
// These narrow `unknown` Responses items/parts by their type discriminant so
// consumers can read fields only some variants declare. They carry no handler
// or transport state, which is what makes them a stable seam: the Responses
// handler tree (`modelHandlerOpenAIResponse`, the WebSocket transport helpers)
// and the chat-export normalizer (`normalizeConversation`) all import guards
// from here, so a Responses-API shape change updates this file and the handler
// without churning the exporter's import surface.

import type {
  ResponseFunctionToolCallItem,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

/** Type guard for Responses API `function_call` output items. */
export function isResponseFunctionToolCallItem(
  item: unknown,
): item is ResponseFunctionToolCallItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'function_call'
  );
}

/** Type guard for Responses API `function_call_output` input items. */
export function isFunctionCallOutputItem(
  item: unknown,
): item is ResponseInputItem.FunctionCallOutput {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'function_call_output'
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
