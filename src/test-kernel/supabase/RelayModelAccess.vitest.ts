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
  isRetiredModelRequest,
} from '../../../supabase/functions/relay/models';

describe('relay tier model access', () => {
  it('gives Max full explicit-model access and Ultra passthrough', () => {
    assert.equal(TIER_CONFIG.tiers.Max?.models, '*');
    assert.equal(TIER_CONFIG.tiers.Ultra?.models, '*');

    assert.equal(isModelAllowedForTier(MAX_TIER, 'unknown-model'), true);
    assert.equal(isModelAllowedForTier(MAX_TIER, null), false);
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
    assert.equal(isModelAllowedForTier(FREE_TIER, 'muse-spark-1.1'), false);
    assert.equal(isModelAllowedForTier(FREE_TIER, 'unknown-model'), false);
    assert.equal(isModelAllowedForTier(FREE_TIER, null), false);
  });

  it('denies retired registry models for relay passthrough tiers', () => {
    assert.equal(isRetiredModelRequest('haiku3'), true);
    assert.equal(
      isRetiredModelRequest('anthropic/claude-3.5-haiku-20240307:beta'),
      true,
    );
    assert.equal(isRetiredModelRequest('unknown-model'), false);

    assert.equal(
      isModelAllowedForTier(MAX_TIER, 'claude-3-haiku-20240307'),
      false,
    );
    assert.equal(
      isModelAllowedForTier(ULTRA_TIER, 'anthropic/claude-3-haiku-20240307'),
      false,
    );
    assert.equal(isModelAllowedForTier(ULTRA_TIER, 'unknown-model'), true);
  });
});
