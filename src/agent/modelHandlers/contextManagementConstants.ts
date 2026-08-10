/** Minimum completion tokens when reducing max tokens due to context pressure. */
const MIN_COMPLETION_TOKENS = 100;

/** Safety buffer for exact token counting (Anthropic, Google). */
export const TOKEN_SAFETY_BUFFER = 10;

/** Max output factor for tool-use agents (reserves headroom for context growth). */
export const TOOL_USE_MAX_OUTPUT_FACTOR = 0.7;

/** Max output factor for chained responses (previous_response_id). */
export const CHAINED_RESPONSE_MAX_OUTPUT_FACTOR = 0.7;

/** Safety buffer for tool-use mode (accounts for tokenization differences and API framing). */
export const TOOL_USE_SAFETY_BUFFER = 2000;

/** Percentage safety margin for chained responses (scales with conversation size). */
export const CHAINED_RESPONSE_SAFETY_MARGIN_PERCENT = 5;

/** Max character length for tool result text (200KB ~ 50-66k tokens). */
export const MAX_TOOL_RESULT_TEXT_LENGTH = 200_000;

/**
 * Head/tail kept from an oversized tool result instead of discarding it
 * wholesale. Head is small (just enough to name the invoked engine/file);
 * tail is large because LaTeX/build errors cluster at the end of long logs.
 */
export const TOOL_RESULT_TRUNCATION_HEAD_CHARS = 4_000;
export const TOOL_RESULT_TRUNCATION_TAIL_CHARS = 50_000;

/** Max PDF pages per Anthropic API request: 600 for 1M-context models, 100 for 200K-context models. */
const ANTHROPIC_MAX_PDF_PAGES_1M = 600;
const ANTHROPIC_MAX_PDF_PAGES_200K = 100;

/** Returns the PDF page limit based on the model's effective context window. */
export function getAnthropicMaxPdfPages(contextWindow: number): number {
  return contextWindow > 200_000
    ? ANTHROPIC_MAX_PDF_PAGES_1M
    : ANTHROPIC_MAX_PDF_PAGES_200K;
}

/** Max tokens for the compaction summary response (client-side compaction for OpenAI-compatible models). */
export const CLIENT_COMPACTION_SUMMARY_MAX_TOKENS = 2000;

/**
 * Prefix prepended to a client-side compaction summary when it is folded back
 * into the conversation as a synthetic user message. Shared across every
 * provider handler so the resumed-conversation marker stays identical.
 */
export const COMPACTION_SUMMARY_PREFIX = '[Previous conversation summary]\n\n';

/**
 * Rough chars-per-token ratio for estimating token counts without a tokenizer.
 * ~4 chars/token is the standard approximation for GPT-family models on English
 * and code. Used only where exact counting is unavailable — e.g. the
 * ChatGPT-subscription (Codex) profile, whose backend exposes no token-counting
 * endpoint (`supportsTokenCounting: false`).
 */
const ESTIMATED_CHARS_PER_TOKEN = 4;

/**
 * Heuristic token estimate for `text` when no tokenizer or counting API is
 * available. Deliberately coarse — callers pair it with a safety buffer.
 */
export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

/** System prompt used for client-side conversation compaction. */
export const COMPACTION_SYSTEM_PROMPT = `Summarize the conversation below. Preserve:
- The original user request and goals
- All key decisions made
- File paths and code changes discussed or made
- Tool call results and their outcomes
- Current state of the task (what is done, what is pending)
- Any errors encountered and how they were resolved

Write a structured summary with enough context to continue the task. Output only the summary.`;

/** Final user instruction that makes the compaction task explicit after history. */
export const COMPACTION_USER_PROMPT =
  'Summarize the conversation history above now. Follow the compaction instructions exactly and output only the summary.';

/** Compute reduced max tokens under context pressure (minimum 1). */
export function computeReducedMaxTokens(
  availableTokens: number,
  tokenBuffer: number = TOKEN_SAFETY_BUFFER,
): number {
  if (availableTokens <= 0) return 1;
  const buffered = availableTokens - tokenBuffer;
  return buffered >= MIN_COMPLETION_TOKENS ? buffered : availableTokens;
}
