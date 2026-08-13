// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - utils
import {
  ANTHROPIC_STOP,
  GOOGLE_FINISH,
  isTokenLimitStopReason,
  MCP_STOP,
  OPENAI_CHAT_FINISH,
} from '@agent/types/StopReasonTypes';

describe('isTokenLimitStopReason', () => {
  it.each([
    OPENAI_CHAT_FINISH.LENGTH,
    ANTHROPIC_STOP.MAX_TOKENS,
    ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED,
    MCP_STOP.MAX_TOKENS,
    GOOGLE_FINISH.MAX_TOKENS,
  ])('detects known enum value %s', (reason) => {
    expect(isTokenLimitStopReason(reason)).toBe(true);
  });

  it.each([undefined, 'stop', 'function_call'])(
    'ignores unrelated stop reason %s',
    (reason) => {
      expect(isTokenLimitStopReason(reason)).toBe(false);
    },
  );

  // These used to match the deleted keyword-based fallback ladder; only
  // exact enum values should match now.
  it.each(['max-token', 'Token limit reached', 'token_limit'])(
    'does not match near-miss string %s via substring fallback',
    (reason) => {
      expect(isTokenLimitStopReason(reason)).toBe(false);
    },
  );
});
