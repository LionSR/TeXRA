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

/** Max PDF pages per Anthropic API request: 600 for 1M-context models, 100 for 200K-context models. */
const ANTHROPIC_MAX_PDF_PAGES_1M = 600;
const ANTHROPIC_MAX_PDF_PAGES_200K = 100;

/** Returns the PDF page limit based on the model's effective context window. */
export function getAnthropicMaxPdfPages(contextWindow: number): number {
  return contextWindow > 200_000
    ? ANTHROPIC_MAX_PDF_PAGES_1M
    : ANTHROPIC_MAX_PDF_PAGES_200K;
}

/** Compute reduced max tokens under context pressure (minimum 1). */
export function computeReducedMaxTokens(
  availableTokens: number,
  tokenBuffer: number = TOKEN_SAFETY_BUFFER,
): number {
  if (availableTokens <= 0) return 1;
  const buffered = availableTokens - tokenBuffer;
  return buffered >= MIN_COMPLETION_TOKENS ? buffered : availableTokens;
}
