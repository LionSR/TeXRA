/**
 * Shared provider content-block schema and cross-shape normalizers.
 *
 * Single source of truth for the discriminated content-block vocabulary that
 * both `assistantBlockToNode` (`@agent/export/normalizeConversation`) and
 * `formatConversationBlock` (`@agent/storage/conversationFormat`) classify —
 * Anthropic/OpenAI `type`-tagged blocks (including Anthropic's server-side
 * tool blocks) and the VS Code language-model bridge's `kind`-tagged blocks.
 * Each consumer still owns its own output shape (a structured `ExportNode`
 * vs. a truncated marker string) and its own further business rules (which
 * block kinds are visible, how they're truncated) — only the wire-shape
 * recognition lives here, so a new provider block type is added once instead
 * of drifting between two independently hand-rolled switches.
 *
 * Google GenAI's discriminator-less `{text}`/`{functionCall}`/
 * `{functionResponse}`/`{thought}` parts are deliberately NOT normalized
 * here: Google never sets a `type` or `kind` tag, so there is no shared
 * literal vocabulary to centralize, and the two consumers already read those
 * fields under materially different rules (`normalizeConversation`'s
 * `googlePartToBlocks` suppresses `thought` parts as provider reasoning;
 * `conversationFormat` has never special-cased `thought` and renders a
 * thought part's `text` field like any other text). Each module keeps its
 * own Google-part handling.
 */
import { z } from 'zod';

import { CONVERSATION_BLOCK_TYPES } from './ConversationBlockTypes';
import { ANTHROPIC_SERVER_TOOL_BLOCK_TYPES } from './ServerToolTypes';

/** One entry inside a `web_search_tool_result` block's `content` array. */
const WebSearchResultItemSchema = z.object({
  type: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
});

/**
 * Discriminated union of API content blocks across the provider shapes that
 * carry a `type` tag: Anthropic, OpenAI Chat Completions, OpenAI Response
 * API, and Anthropic's server-side tool blocks. Each variant declares only
 * the fields that provider actually populates for that block kind, so
 * consumers can switch/narrow on `type` instead of re-deriving validity with
 * ad hoc optional-field checks.
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
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
  // VS Code language-model bridge (see {@link normalizeVsCodeLmBlock}).
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
  // (currently it isn't for this variant; see the module-level
  // type-derivation-only note in the consuming modules).
  z.looseObject({
    type: z.literal(ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webFetchToolResult),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// ============================================================
// VS Code language-model bridge — `kind`-tagged parts
// ============================================================

const VsCodeLmBlockShapeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.unknown().optional() }),
  z.object({
    kind: z.literal('toolCall'),
    name: z.unknown().optional(),
    input: z.unknown().optional(),
  }),
  z.object({ kind: z.literal('toolResult'), text: z.unknown().optional() }),
]);

/** The subset of {@link ContentBlock} that a VS Code LM part normalizes into. */
type NormalizedVsCodeLmBlock = Extract<
  ContentBlock,
  | { type: 'text' }
  | { type: typeof CONVERSATION_BLOCK_TYPES.toolUse }
  | { type: typeof CONVERSATION_BLOCK_TYPES.toolResult }
>;

const VsCodeLmBlockSchema = VsCodeLmBlockShapeSchema.transform(
  (b): NormalizedVsCodeLmBlock => {
    switch (b.kind) {
      case 'text':
        return {
          type: 'text',
          text: typeof b.text === 'string' ? b.text : undefined,
        };
      case 'toolCall':
        return {
          type: CONVERSATION_BLOCK_TYPES.toolUse,
          name: typeof b.name === 'string' ? b.name : undefined,
          input: b.input,
        };
      case 'toolResult':
        return { type: CONVERSATION_BLOCK_TYPES.toolResult, content: b.text };
    }
  },
);

/**
 * Normalize one VS Code language-model content part — `{kind: 'text' |
 * 'toolCall' | 'toolResult', ...}` — into the canonical `type`-tagged
 * {@link ContentBlock} shape used by every other provider. Returns
 * `undefined` for anything that isn't a recognized `kind`-tagged block,
 * including blocks with no `kind` at all (every other provider's blocks) —
 * callers fall back to their own handling for that case.
 */
export function normalizeVsCodeLmBlock(
  raw: unknown,
): NormalizedVsCodeLmBlock | undefined {
  const parsed = VsCodeLmBlockSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
