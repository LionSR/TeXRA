import type { StopReason as AnthropicSDKStopReason } from '@anthropic-ai/sdk/resources/messages';
import type { ChatCompletion } from 'openai/resources/chat/completions';

/**
 * Finish reasons returned by the OpenAI Chat Completion API.
 * These are distinct from the Responses API status values.
 */
export const OPENAI_CHAT_FINISH = {
  STOP: 'stop',
  LENGTH: 'length',
  TOOL_CALLS: 'tool_calls',
  CONTENT_FILTER: 'content_filter',
  FUNCTION_CALL: 'function_call',
} as const satisfies Record<string, NonNullable<OpenAIChatFinishReason>>;
type OpenAIChatFinishReason = ChatCompletion.Choice['finish_reason'];

/** Stop reasons defined in the Model Context Protocol SDK. */
export const MCP_STOP = {
  MAX_TOKENS: 'maxTokens',
} as const;
type MCPStopReason = (typeof MCP_STOP)[keyof typeof MCP_STOP];

/**
 * Stop reasons for Anthropic models.
 * Runtime constants for comparison - values match SDK's StopReason type.
 */
export const ANTHROPIC_STOP = {
  END_TURN: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  MODEL_CONTEXT_WINDOW_EXCEEDED: 'model_context_window_exceeded',
  STOP_SEQUENCE: 'stop_sequence',
  TOOL_USE: 'tool_use',
  PAUSE_TURN: 'pause_turn',
  REFUSAL: 'refusal',
} as const satisfies Record<string, AnthropicSDKStopReason>;

/**
 * Google GenAI finish reasons. Kept as string constants so shared stop-reason
 * utilities do not eagerly import the Google SDK.
 */
export const GOOGLE_FINISH = {
  STOP: 'STOP',
  MAX_TOKENS: 'MAX_TOKENS',
} as const;
type GoogleFinishReason = (typeof GOOGLE_FINISH)[keyof typeof GOOGLE_FINISH];

/**
 * Provider stop reasons flowing through shared flow code.
 *
 * The trailing `| string` escape hatch collapses the union to `string`, which
 * is deliberate: production handlers assign literals that do not exist in the
 * provider SDK enums (e.g. `'UNKNOWN_EMPTY_RESPONSE'` in the Google
 * Interactions handler, `'stop'` in the Anthropic handler), so narrowing to
 * the enum members above would break those assignments. The const tables
 * (`OPENAI_CHAT_FINISH`, `ANTHROPIC_STOP`, ...) serve as the typed,
 * enumerable documentation of the known values; the escape hatch keeps this
 * type usable for reasons the enums haven't caught up to.
 */
export type ProviderStopReason =
  | OpenAIChatFinishReason
  | AnthropicSDKStopReason
  | GoogleFinishReason
  | MCPStopReason
  | string;

/** Known stop reasons that indicate token limit was hit. */
const TOKEN_LIMIT_STOP_REASONS: readonly ProviderStopReason[] = [
  OPENAI_CHAT_FINISH.LENGTH,
  ANTHROPIC_STOP.MAX_TOKENS,
  ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED,
  MCP_STOP.MAX_TOKENS,
  GOOGLE_FINISH.MAX_TOKENS,
];

/**
 * Determines whether a provider stop reason represents a token limit hit.
 *
 * Every supported SDK reports a clean enum stop reason for this condition, so
 * this is a direct membership check against the known enum values.
 */
export function isTokenLimitStopReason(
  reason: ProviderStopReason | undefined,
): boolean {
  return !!reason && TOKEN_LIMIT_STOP_REASONS.includes(reason);
}

/**
 * Whether a provider stop reason specifically means the model's context
 * window (not just an output token budget) was exceeded — Anthropic today,
 * but kept as a semantic predicate so shared flow code never compares
 * against a raw provider constant.
 */
export function isContextWindowExceededStopReason(
  reason: ProviderStopReason | undefined,
): boolean {
  return reason === ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED;
}
