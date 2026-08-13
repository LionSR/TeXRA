import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';

import { capOpenAIReasoningEffortForTier } from '../../../supabase/functions/relay/reasoning';
import {
  FREE_TIER,
  MAX_TIER,
  ULTRA_TIER,
} from '../../../supabase/functions/relay/models';

const TIER_CAPS = {
  [FREE_TIER]: 'medium',
  [MAX_TIER]: 'high',
} as const;

describe('relay GPT-5 reasoning effort caps', () => {
  it.each([
    {
      name: 'caps chat-completions xhigh to medium for free tier GPT-5 requests',
      body: { model: 'gpt-5-mini-2025-08-15', reasoning_effort: 'xhigh' },
      provider: 'openai',
      tier: FREE_TIER,
      expected: { model: 'gpt-5-mini-2025-08-15', reasoning_effort: 'medium' },
    },
    {
      name: 'caps responses xhigh to high for Max tier GPT-5 requests',
      body: {
        model: 'openai/gpt5-mini',
        reasoning: { effort: 'xhigh', summary: 'auto' },
      },
      provider: 'openai',
      tier: MAX_TIER,
      expected: {
        model: 'openai/gpt5-mini',
        reasoning: { effort: 'high', summary: 'auto' },
      },
    },
  ])('$name', ({ body, provider, tier, expected }) => {
    assert.deepEqual(
      capOpenAIReasoningEffortForTier(body, {
        provider,
        tier,
        modelName: body.model,
        tierCaps: TIER_CAPS,
      }),
      expected,
    );
  });

  // No cap applies, so the helper returns the exact same body reference
  // (asserted via identity equality, not deep equality).
  it.each([
    {
      name: 'does not cap Ultra tier GPT-5 requests',
      body: { model: 'gpt-5-mini-2025-08-15', reasoning_effort: 'xhigh' },
      provider: 'openai',
      tier: ULTRA_TIER,
    },
    {
      name: 'does not cap non-GPT-5 requests',
      body: { model: 'gpt-4.1', reasoning_effort: 'xhigh' },
      provider: 'openai',
      tier: FREE_TIER,
    },
    {
      name: 'does not cap non-OpenAI requests',
      body: { model: 'gpt-5-mini-2025-08-15', reasoning_effort: 'xhigh' },
      provider: 'deepseek',
      tier: FREE_TIER,
    },
  ])('$name', ({ body, provider, tier }) => {
    assert.equal(
      capOpenAIReasoningEffortForTier(body, {
        provider,
        tier,
        modelName: body.model,
        tierCaps: TIER_CAPS,
      }),
      body,
    );
  });
});
