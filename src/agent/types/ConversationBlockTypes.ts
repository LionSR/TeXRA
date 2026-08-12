/**
 * Shared provider content-block `type` tag vocabulary.
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
 * `text`/`input_text`/`output_text` are deliberately NOT included: those are
 * genuinely handled differently in the two consumers (normalizeConversation
 * distinguishes user vs. assistant text roles per literal; conversationFormat
 * recognizes them structurally via a `typeof block.text === 'string'` check
 * that runs before its `type` switch, not via an explicit case per literal),
 * so unifying them here would encode a symmetry that doesn't actually hold.
 *
 * The three Anthropic server-tool block types (`server_tool_use`,
 * `web_search_tool_result`, `web_fetch_tool_result`) are the same kind of
 * shared vocabulary but already live in
 * `ANTHROPIC_SERVER_TOOL_BLOCK_TYPES` (`@agent/types/ServerTools`) —
 * not duplicated here.
 */
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
