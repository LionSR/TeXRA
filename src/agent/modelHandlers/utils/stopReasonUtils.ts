// Third-party imports
import { FinishReason } from '@google/genai';

// Local imports - stop reasons
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
// Internal imports
import {
  ANTHROPIC_STOP,
  MCP_STOP,
  OPENAI_CHAT_FINISH,
  OPENAI_COMPLETION_FINISH,
} from '@agent/modelHandlers/types/StopReasonTypes';

/** Known stop reasons that indicate token limit was hit */
const TOKEN_LIMIT_STOP_REASONS: readonly ProviderStopReason[] = [
  OPENAI_CHAT_FINISH.LENGTH,
  OPENAI_COMPLETION_FINISH.LENGTH,
  ANTHROPIC_STOP.MAX_TOKENS,
  MCP_STOP.MAX_TOKENS,
  FinishReason.MAX_TOKENS,
];

/** Keywords for fallback string matching */
const TOKEN_LIMIT_KEYWORDS = [
  'max_token',
  'max-token',
  'token limit',
  'token_limit',
  'length',
];

/**
 * Determines whether a provider stop reason represents a token limit hit.
 *
 * This consolidates provider-specific enums with best-effort string matching so
 * call sites can share the same continuation heuristics.
 */
export function isTokenLimitStopReason(
  reason: ProviderStopReason | undefined,
): boolean {
  if (!reason) return false;

  if (TOKEN_LIMIT_STOP_REASONS.includes(reason)) {
    return true;
  }

  const normalized = String(reason).toLowerCase();
  return TOKEN_LIMIT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}
