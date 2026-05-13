// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - Supabase relay
import { capOpenAIReasoningEffortForTier } from '../../../supabase/functions/relay/reasoning';
import {
  FREE_TIER,
  MAX_TIER,
  ULTRA_TIER,
} from '../../../supabase/functions/relay/tierConstants';

const TIER_CAPS = {
  [FREE_TIER]: 'medium',
  [MAX_TIER]: 'high',
} as const;

describe('relay GPT-5 reasoning effort caps', () => {
  it('caps chat-completions xhigh to medium for free tier GPT-5 requests', () => {
    const body = {
      model: 'gpt-5-mini-2025-08-15',
      reasoning_effort: 'xhigh',
    };

    assert.deepEqual(
      capOpenAIReasoningEffortForTier(body, {
        provider: 'openai',
        tier: FREE_TIER,
        modelName: body.model,
        tierCaps: TIER_CAPS,
      }),
      {
        model: 'gpt-5-mini-2025-08-15',
        reasoning_effort: 'medium',
      },
    );
  });

  it('caps responses xhigh to high for Max tier GPT-5 requests', () => {
    const body = {
      model: 'openai/gpt5-mini',
      reasoning: { effort: 'xhigh', summary: 'auto' },
    };

    assert.deepEqual(
      capOpenAIReasoningEffortForTier(body, {
        provider: 'openai',
        tier: MAX_TIER,
        modelName: body.model,
        tierCaps: TIER_CAPS,
      }),
      {
        model: 'openai/gpt5-mini',
        reasoning: { effort: 'high', summary: 'auto' },
      },
    );
  });

  it('does not cap Ultra tier GPT-5 requests', () => {
    const body = {
      model: 'gpt-5-mini-2025-08-15',
      reasoning_effort: 'xhigh',
    };

    assert.equal(
      capOpenAIReasoningEffortForTier(body, {
        provider: 'openai',
        tier: ULTRA_TIER,
        modelName: body.model,
        tierCaps: TIER_CAPS,
      }),
      body,
    );
  });

  it('does not cap non-GPT-5 or non-OpenAI requests', () => {
    const nonGpt5Body = {
      model: 'gpt-4.1',
      reasoning_effort: 'xhigh',
    };
    const nonOpenAIBody = {
      model: 'gpt-5-mini-2025-08-15',
      reasoning_effort: 'xhigh',
    };

    assert.equal(
      capOpenAIReasoningEffortForTier(nonGpt5Body, {
        provider: 'openai',
        tier: FREE_TIER,
        modelName: nonGpt5Body.model,
        tierCaps: TIER_CAPS,
      }),
      nonGpt5Body,
    );
    assert.equal(
      capOpenAIReasoningEffortForTier(nonOpenAIBody, {
        provider: 'deepseek',
        tier: FREE_TIER,
        modelName: nonOpenAIBody.model,
        tierCaps: TIER_CAPS,
      }),
      nonOpenAIBody,
    );
  });
});
