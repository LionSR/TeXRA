/**
 * Shared provider content-block `type` tag vocabulary and classification.
 *
 * Single source of truth for the non-text block-type literals that both
 * `formatConversationBlock` (`@agent/storage/conversationFormat`) and
 * `assistantBlockToNode`/`blocksToUserParts`/`extractToolResultText`
 * (`@agent/export/normalizeConversation`) must recognize. Each consumer maps
 * the canonical {@link ProviderMessageBlockCategory} into its own output shape,
 * so the vocabulary and classification live in one place.
 *
 * `text`/`input_text`/`output_text` are deliberately NOT included: those are
 * genuinely handled differently in the two consumers, so the classifier
 * returns `undefined` for them (and for any unrecognized tag), leaving each
 * consumer's own fallback in place.
 *
 * The Anthropic server-tool tags live in
 * {@link ANTHROPIC_SERVER_TOOL_BLOCK_TYPES} (`@agent/types/ServerTools`) and
 * are imported here for classification, not duplicated.
 */
import { ANTHROPIC_SERVER_TOOL_BLOCK_TYPES } from '@agent/types/ServerTools';

export const CONVERSATION_BLOCK_TYPES = Object.freeze({
  // Anthropic and Google GenAI extended-thinking / thought blocks.
  thinking: 'thinking',
  redactedThinking: 'redacted_thinking',

  // Local tool-call / tool-result blocks (Anthropic, Google GenAI, and the
  // VS Code language-model bridge normalize into this shape).
  toolUse: 'tool_use',
  toolResult: 'tool_result',

  // Image attachment markers: Anthropic ('image'), OpenAI Response API
  // ('input_image'), OpenAI Chat Completions ('image_url').
  image: 'image',
  inputImage: 'input_image',
  imageUrl: 'image_url',

  // Document attachment markers: Anthropic ('document'), OpenAI Response API
  // ('input_file'), OpenAI Chat Completions ('file').
  document: 'document',
  inputFile: 'input_file',
  file: 'file',
} as const);

const CATEGORY_BY_BLOCK_TYPE = Object.freeze({
  [CONVERSATION_BLOCK_TYPES.image]: 'image-attachment',
  [CONVERSATION_BLOCK_TYPES.imageUrl]: 'image-attachment',
  [CONVERSATION_BLOCK_TYPES.inputImage]: 'image-attachment',

  [CONVERSATION_BLOCK_TYPES.document]: 'document-attachment',
  [CONVERSATION_BLOCK_TYPES.inputFile]: 'document-attachment',
  [CONVERSATION_BLOCK_TYPES.file]: 'document-attachment',

  [CONVERSATION_BLOCK_TYPES.thinking]: 'thinking',
  [CONVERSATION_BLOCK_TYPES.redactedThinking]: 'thinking',

  [CONVERSATION_BLOCK_TYPES.toolUse]: 'tool-use',
  [CONVERSATION_BLOCK_TYPES.toolResult]: 'tool-result',

  [ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.serverToolUse]: 'server-tool-use',
  [ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webSearchToolResult]:
    'web-search-tool-result',
  [ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webFetchToolResult]:
    'web-fetch-tool-result',
} as const);

/**
 * Canonical classification of a provider message block's non-text `type`
 * tag.
 */
export type ProviderMessageBlockCategory =
  (typeof CATEGORY_BY_BLOCK_TYPE)[keyof typeof CATEGORY_BY_BLOCK_TYPE];

/**
 * Map a raw provider message block's `type` tag to its
 * {@link ProviderMessageBlockCategory}, or `undefined` when the tag is a text
 * literal or unrecognized.
 */
export function classifyProviderMessageBlockType(
  type: unknown,
): ProviderMessageBlockCategory | undefined {
  // `Object.hasOwn` guard, not a bare index: the map inherits from
  // `Object.prototype`, so a provider block typed `'toString'` or
  // `'constructor'` would otherwise return a function into consumer switches
  // that `assertNever` on anything unrecognized.
  return typeof type === 'string' && Object.hasOwn(CATEGORY_BY_BLOCK_TYPE, type)
    ? CATEGORY_BY_BLOCK_TYPE[type as keyof typeof CATEGORY_BY_BLOCK_TYPE]
    : undefined;
}
