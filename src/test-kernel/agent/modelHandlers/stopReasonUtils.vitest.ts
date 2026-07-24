// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - utils
import { isTokenLimitStopReason } from '@agent/types/StopReasonTypes';
import {
  ANTHROPIC_STOP,
  GOOGLE_FINISH,
  MCP_STOP,
  OPENAI_CHAT_FINISH,
  OPENAI_COMPLETION_FINISH,
} from '@agent/types/StopReasonTypes';

describe('isTokenLimitStopReason', () => {
  it('detects known enum values', () => {
    assert.equal(isTokenLimitStopReason(OPENAI_CHAT_FINISH.LENGTH), true);
    assert.equal(isTokenLimitStopReason(OPENAI_COMPLETION_FINISH.LENGTH), true);
    assert.equal(isTokenLimitStopReason(ANTHROPIC_STOP.MAX_TOKENS), true);
    assert.equal(
      isTokenLimitStopReason(ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED),
      true,
    );
    assert.equal(isTokenLimitStopReason(MCP_STOP.MAX_TOKENS), true);
    assert.equal(isTokenLimitStopReason(GOOGLE_FINISH.MAX_TOKENS), true);
  });

  it('ignores unrelated stop reasons', () => {
    assert.equal(isTokenLimitStopReason(undefined), false);
    assert.equal(isTokenLimitStopReason('stop'), false);
    assert.equal(isTokenLimitStopReason('function_call'), false);
  });

  it('no longer matches near-miss strings via substring fallback', () => {
    // These used to match the deleted keyword-based fallback ladder; only
    // exact enum values should match now.
    assert.equal(isTokenLimitStopReason('max-token'), false);
    assert.equal(isTokenLimitStopReason('Token limit reached'), false);
    assert.equal(isTokenLimitStopReason('token_limit'), false);
  });
});
