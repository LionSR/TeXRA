// Local imports - stop reasons
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';

// Internal imports
import {
  ANTHROPIC_STOP,
  GOOGLE_FINISH,
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
  GOOGLE_FINISH.MAX_TOKENS,
];

/**
 * Determines whether a provider stop reason represents a token limit hit.
 *
 * Every supported SDK reports a clean enum stop reason for this condition, so
 * this is a direct membership check against the known enum values — no
 * best-effort string matching.
 */
export function isTokenLimitStopReason(
  reason: ProviderStopReason | undefined,
): boolean {
  if (!reason) return false;
  return TOKEN_LIMIT_STOP_REASONS.includes(reason);
}
