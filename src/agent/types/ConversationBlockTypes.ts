/**
 * Shared provider content-block `type` tag vocabulary and classification.
 *
 * Single source of truth for the non-server-tool block-type literals that
 * both `assistantBlockToNode`/`ContentBlockSchema`
 * (`@agent/export/normalizeConversation`) and `formatConversationBlock`
 * (`@agent/storage/conversationFormat`) must recognize by exact string —
 * image/document attachment markers, provider "thinking" blocks, and local
 * tool-call/tool-result blocks. Both modules read these tags off raw
 * provider wire data (Anthropic, OpenAI Chat Completions, OpenAI Response
 * API), so a hand-typed literal that drifts between the two files (e.g. a
 * typo, or a new provider alias added to only one switch) fails silently
 * instead of at compile time. Importing from here instead of repeating the
 * strings turns that drift into a single edit site.
 *
 * `classifyProviderMessageBlockType` below is the one switch that maps each
 * of those tags (and the three server-tool tags) to its canonical
 * {@link ProviderMessageBlockCategory}; both consumers switch on the
 * category and differ only in how they RENDER it (a truncated marker string
 * in conversationFormat vs. a structured `ExportNode` in
 * normalizeConversation).
 *
 * `text`/`input_text`/`output_text` are deliberately NOT included: those are
 * genuinely handled differently in the two consumers (normalizeConversation
 * distinguishes user vs. assistant text roles per literal; conversationFormat
 * recognizes them structurally via a `typeof block.text === 'string'` check
 * that runs before its `type` switch, not via an explicit case per literal),
 * so unifying them here would encode a symmetry that doesn't actually hold.
 * For the same reason the classifier returns `undefined` for them (and for
 * any unrecognized tag), leaving each consumer's own fallback in place.
 *
 * The three Anthropic server-tool block types (`server_tool_use`,
 * `web_search_tool_result`, `web_fetch_tool_result`) are the same kind of
 * shared vocabulary but already live in
 * `ANTHROPIC_SERVER_TOOL_BLOCK_TYPES` (`@agent/types/ServerTools`) —
 * imported here for classification, not duplicated.
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

/**
 * Canonical classification of a provider message block's non-text `type`
 * tag. Both consumer switches — `formatConversationBlock`
 * (`@agent/storage/conversationFormat`) and
 * `assistantBlockToNode`/`blocksToUserParts`/`extractToolResultText`
 * (`@agent/export/normalizeConversation`) — must recognize the same tags;
 * this is the one place that maps each tag to its category, and each
 * consumer maps the category into its own output shape (a truncated marker
 * string vs. a structured `ExportNode`).
 */
export type ProviderMessageBlockCategory =
  | 'image-attachment'
  | 'document-attachment'
  | 'thinking'
  | 'tool-use'
  | 'tool-result'
  | 'server-tool-use'
  | 'web-search-tool-result'
  | 'web-fetch-tool-result';

/**
 * Map a raw provider message block's `type` tag to its
 * {@link ProviderMessageBlockCategory}, or `undefined` when the tag is a
 * text literal (`text`/`input_text`/`output_text` — deliberately handled
 * per-consumer, see the module docstring) or is unrecognized.
 */
export function classifyProviderMessageBlockType(
  type: unknown,
): ProviderMessageBlockCategory | undefined {
  switch (type) {
    case CONVERSATION_BLOCK_TYPES.image:
    case CONVERSATION_BLOCK_TYPES.imageUrl:
    case CONVERSATION_BLOCK_TYPES.inputImage:
      return 'image-attachment';
    case CONVERSATION_BLOCK_TYPES.document:
    case CONVERSATION_BLOCK_TYPES.file:
    case CONVERSATION_BLOCK_TYPES.inputFile:
      return 'document-attachment';
    case CONVERSATION_BLOCK_TYPES.thinking:
    case CONVERSATION_BLOCK_TYPES.redactedThinking:
      return 'thinking';
    case CONVERSATION_BLOCK_TYPES.toolUse:
      return 'tool-use';
    case CONVERSATION_BLOCK_TYPES.toolResult:
      return 'tool-result';
    case ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.serverToolUse:
      return 'server-tool-use';
    case ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webSearchToolResult:
      return 'web-search-tool-result';
    case ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webFetchToolResult:
      return 'web-fetch-tool-result';
    default:
      return undefined;
  }
}
