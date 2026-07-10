import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

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

  it('keeps the workspace llm-zoo dependency in sync with the relay deno.json pin', () => {
    const workspacePackageJson = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const workspaceRange = workspacePackageJson.dependencies?.['llm-zoo'];
    expect(
      workspaceRange,
      'package.json is missing an llm-zoo dependency',
    ).toBeDefined();
    // Workspace pin is a caret range (e.g. "^1.12.0"); strip the range
    // operator to compare against the relay's exact version.
    const workspaceVersion = workspaceRange!.replace(/^[\^~]/, '');

    const relayDenoJson = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT, 'supabase/functions/relay/deno.json'),
        'utf8',
      ),
    ) as { imports?: Record<string, string> };
    const relaySpecifier = relayDenoJson.imports?.['llm-zoo'];
    expect(
      relaySpecifier,
      'supabase/functions/relay/deno.json is missing an llm-zoo import',
    ).toBeDefined();
    // Relay pin is an exact npm specifier (e.g. "npm:llm-zoo@1.12.0").
    const relayVersion = relaySpecifier!.replace(/^npm:llm-zoo@/, '');

    expect(
      relayVersion,
      `llm-zoo version skew: package.json pins ${workspaceRange} but relay ` +
        `deno.json pins ${relaySpecifier}. Update ` +
        'supabase/functions/relay/deno.json (and refresh deno.lock) or ' +
        'package.json so both point to the same version.',
    ).toBe(workspaceVersion);
  });
});
