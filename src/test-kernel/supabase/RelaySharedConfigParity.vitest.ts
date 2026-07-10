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

  it('keeps the workspace llm-zoo range floor in sync with the relay deno.json pin', () => {
    const workspacePackageJson = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const workspaceRange = workspacePackageJson.dependencies?.['llm-zoo'];
    expect(
      workspaceRange,
      'package.json is missing an llm-zoo dependency',
    ).toBeDefined();
    // Workspace pin is a caret range (e.g. "^1.12.0"); strip the range
    // operator to compare against the relay's exact version. This only
    // checks the declared floor — pnpm may resolve a higher patch/minor
    // within the caret range, which the resolved-version check below
    // catches.
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
      `llm-zoo range floor skew: package.json pins ${workspaceRange} but ` +
        `relay deno.json pins ${relaySpecifier}. Update ` +
        'supabase/functions/relay/deno.json (and refresh deno.lock) or ' +
        'package.json so both point to the same version.',
    ).toBe(workspaceVersion);
  });

  it('keeps the pnpm-resolved llm-zoo version in sync with the relay deno.json pin', () => {
    // package.json declares a caret range, so pnpm can legitimately resolve
    // a patch/minor above the floor asserted in the previous test (e.g.
    // ^1.12.0 resolving to 1.12.5) while the relay stays pinned to the
    // exact 1.12.0 it imports. Compare against the version pnpm actually
    // resolved in the lockfile so that skew is caught even when it hides
    // inside the caret range.
    const pnpmLockYaml = readFileSync(
      resolve(REPO_ROOT, 'pnpm-lock.yaml'),
      'utf8',
    );
    // Top-level package entries in the pnpm-lock.yaml `packages:` block are
    // indented exactly two spaces, e.g. "  llm-zoo@1.12.0:". A tolerant
    // regex avoids pulling in a full YAML parser for a multi-megabyte file.
    const resolvedMatch = pnpmLockYaml.match(/^ {2}llm-zoo@([^:\s(]+):/m);
    expect(
      resolvedMatch,
      'pnpm-lock.yaml is missing a resolved llm-zoo package entry',
    ).not.toBeNull();
    const resolvedVersion = resolvedMatch![1];

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
    const relayVersion = relaySpecifier!.replace(/^npm:llm-zoo@/, '');

    expect(
      relayVersion,
      `llm-zoo version skew: pnpm-lock.yaml resolves llm-zoo@${resolvedVersion} ` +
        `but relay deno.json pins ${relaySpecifier}. Update ` +
        'supabase/functions/relay/deno.json (and refresh deno.lock) and/or ' +
        'the workspace pnpm-lock.yaml so both point to the same version.',
    ).toBe(resolvedVersion);
  });
});
