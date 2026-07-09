import { describe, expect, it } from 'vitest';

import {
  FREE_TIER,
  getRelaySpendingLimit,
  MAX_TIER,
  ULTRA_TIER,
  UserTierSchema,
} from '@auth/sharedConfig';

import {
  FREE_TIER as RELAY_FREE_TIER,
  MAX_TIER as RELAY_MAX_TIER,
  TIER_SPENDING_LIMITS,
  ULTRA_TIER as RELAY_ULTRA_TIER,
} from '../../../supabase/functions/relay/models';

const CLIENT_TIERS = UserTierSchema.options;
const RELAY_TIERS = [RELAY_FREE_TIER, RELAY_MAX_TIER, RELAY_ULTRA_TIER];

describe('relay shared configuration parity', () => {
  it('keeps client and relay tier strings identical', () => {
    expect(RELAY_TIERS).toEqual(CLIENT_TIERS);
    expect([FREE_TIER, MAX_TIER, ULTRA_TIER]).toEqual(RELAY_TIERS);
  });

  it('keeps client and relay spending limits identical', () => {
    for (const tier of CLIENT_TIERS) {
      expect(getRelaySpendingLimit(tier)).toBe(TIER_SPENDING_LIMITS[tier]);
    }
  });
});
