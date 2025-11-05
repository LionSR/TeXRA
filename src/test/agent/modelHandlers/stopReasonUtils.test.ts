// Third-party imports
import { strict as assert } from 'assert';
import { FinishReason } from '@google/genai';

// Local imports - utils
import { isTokenLimitStopReason } from '@agent/modelHandlers/utils/stopReasonUtils';
import {
  ANTHROPIC_STOP,
  MCP_STOP,
  OPENAI_CHAT_FINISH,
  OPENAI_COMPLETION_FINISH,
} from '@agent/modelHandlers/types/StopReasonTypes';

describe('isTokenLimitStopReason', () => {
  it('detects known enum values', () => {
    assert.equal(isTokenLimitStopReason(OPENAI_CHAT_FINISH.LENGTH), true);
    assert.equal(isTokenLimitStopReason(OPENAI_COMPLETION_FINISH.LENGTH), true);
    assert.equal(isTokenLimitStopReason(ANTHROPIC_STOP.MAX_TOKENS), true);
    assert.equal(isTokenLimitStopReason(MCP_STOP.MAX_TOKENS), true);
    assert.equal(isTokenLimitStopReason(FinishReason.MAX_TOKENS), true);
  });

  it('detects keyword-based token limit strings', () => {
    assert.equal(isTokenLimitStopReason('max_tokens'), true);
    assert.equal(isTokenLimitStopReason('Token limit reached'), true);
    assert.equal(isTokenLimitStopReason('length'), true);
  });

  it('ignores unrelated stop reasons', () => {
    assert.equal(isTokenLimitStopReason(undefined), false);
    assert.equal(isTokenLimitStopReason('stop'), false);
    assert.equal(isTokenLimitStopReason('function_call'), false);
  });
});
