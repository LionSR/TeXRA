// Third-party imports
import { FinishReason } from '@google/genai';

// Local imports - stop reasons
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
import {
  ANTHROPIC_STOP,
  MCP_STOP,
  OPENAI_CHAT_FINISH,
  OPENAI_COMPLETION_FINISH,
} from '@agent/modelHandlers/types/StopReasonTypes';

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
  if (reason === undefined || reason === null) {
    return false;
  }

  if (
    reason === OPENAI_CHAT_FINISH.LENGTH ||
    reason === OPENAI_COMPLETION_FINISH.LENGTH ||
    reason === ANTHROPIC_STOP.MAX_TOKENS ||
    reason === MCP_STOP.MAX_TOKENS ||
    reason === FinishReason.MAX_TOKENS
  ) {
    return true;
  }

  const normalized = String(reason).toLowerCase();
  return TOKEN_LIMIT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}
