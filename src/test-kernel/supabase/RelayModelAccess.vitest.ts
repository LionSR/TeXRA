// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - Supabase relay
import {
  FREE_TIER,
  MAX_TIER,
  TIER_CONFIG,
  ULTRA_TIER,
  isModelAllowedForTier,
} from '../../../supabase/functions/relay/models';

describe('relay tier model access', () => {
  it('gives Max and Ultra full model access', () => {
    assert.equal(TIER_CONFIG.tiers.Max?.models, '*');
    assert.equal(TIER_CONFIG.tiers.Ultra?.models, '*');

    assert.equal(isModelAllowedForTier(MAX_TIER, 'unknown-model'), true);
    assert.equal(isModelAllowedForTier(MAX_TIER, null), true);
    assert.equal(isModelAllowedForTier(ULTRA_TIER, 'unknown-model'), true);
    assert.equal(isModelAllowedForTier(ULTRA_TIER, null), true);
  });

  it('keeps free tier restricted to known price-bounded models', () => {
    assert.equal(isModelAllowedForTier(FREE_TIER, 'gemini-3.5-flash'), true);
    assert.equal(
      isModelAllowedForTier(FREE_TIER, 'google/gemini-3.5-flash'),
      true,
    );
    assert.equal(isModelAllowedForTier(FREE_TIER, 'gpt-5-2025-08-07'), false);
    assert.equal(isModelAllowedForTier(FREE_TIER, 'unknown-model'), false);
    assert.equal(isModelAllowedForTier(FREE_TIER, null), false);
  });
});
