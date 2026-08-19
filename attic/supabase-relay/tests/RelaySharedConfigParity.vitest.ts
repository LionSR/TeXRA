import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  FREE_TIER,
  getRelaySpendingLimit,
  MAX_TIER,
  ULTRA_TIER,
  UserTierSchema,
} from '@auth/config';
import { REPO_ROOT } from '@test/support/repoScan';

import {
  FREE_TIER as RELAY_FREE_TIER,
  MAX_TIER as RELAY_MAX_TIER,
  TIER_SPENDING_LIMITS,
  ULTRA_TIER as RELAY_ULTRA_TIER,
} from '../../../supabase/functions/relay/models';

const CLIENT_TIERS = UserTierSchema.options;
const RELAY_TIERS = [RELAY_FREE_TIER, RELAY_MAX_TIER, RELAY_ULTRA_TIER];

const require = createRequire(import.meta.url);

const RELAY_DENO_JSON_PATH = 'supabase/functions/relay/deno.json';
const LOG_USAGE_DENO_JSON_PATH = 'supabase/functions/log-usage/deno.json';

function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, relativePath), 'utf8'),
  ) as T;
}

/** The relay's exact npm specifier for llm-zoo (e.g. "npm:llm-zoo@1.12.0"). */
function readRelayLlmZooSpecifier(): string {
  const relayDenoJson = readJsonFile<{ imports?: Record<string, string> }>(
    RELAY_DENO_JSON_PATH,
  );
  const relaySpecifier = relayDenoJson.imports?.['llm-zoo'];
  expect(
    relaySpecifier,
    `${RELAY_DENO_JSON_PATH} is missing an llm-zoo import`,
  ).toBeDefined();
  return relaySpecifier!;
}

/** The exact llm-zoo version the relay's specifier pins (e.g. "1.12.0"). */
function readRelayLlmZooVersion(): { specifier: string; version: string } {
  const specifier = readRelayLlmZooSpecifier();
  return { specifier, version: specifier.replace(/^npm:llm-zoo@/, '') };
}

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

  it('defaults only an absent spending tier to free', () => {
    expect(getRelaySpendingLimit(undefined)).toBe(
      TIER_SPENDING_LIMITS[FREE_TIER],
    );
    expect(() => getRelaySpendingLimit('corrupted')).toThrow();
  });

  it('keeps the workspace llm-zoo range floor in sync with the relay deno.json pin', () => {
    const workspacePackageJson = readJsonFile<{
      dependencies?: Record<string, string>;
    }>('package.json');
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

    const relay = readRelayLlmZooVersion();

    expect(
      relay.version,
      `llm-zoo range floor skew: package.json pins ${workspaceRange} but ` +
        `relay deno.json pins ${relay.specifier}. Update ` +
        'supabase/functions/relay/deno.json (and refresh deno.lock) or ' +
        'package.json so both point to the same version.',
    ).toBe(workspaceVersion);
  });

  it('keeps the relay and usage-cost llm-zoo pins identical', () => {
    const logUsageDenoJson = readJsonFile<{
      imports?: Record<string, string>;
    }>(LOG_USAGE_DENO_JSON_PATH);
    expect(
      logUsageDenoJson.imports?.['llm-zoo'],
      `${LOG_USAGE_DENO_JSON_PATH} must match ${RELAY_DENO_JSON_PATH}`,
    ).toBe(readRelayLlmZooSpecifier());
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
    // Scanning the deduplicated `packages:` catalog with a regex is
    // ambiguous: it can match a transitive dependency's `llm-zoo@…:` entry,
    // or (once workspace members' ranges diverge) the wrong one of several
    // peer-suffixed keys for the same package. Read the root importer's
    // resolved version directly instead — `importers['.'].dependencies` is
    // unambiguous by construction.
    const lockfile = parseYaml(pnpmLockYaml) as {
      importers?: Record<
        string,
        { dependencies?: Record<string, { version?: string }> }
      >;
    };
    const rootLlmZoo = lockfile.importers?.['.']?.dependencies?.['llm-zoo'];
    expect(
      rootLlmZoo?.version,
      "pnpm-lock.yaml is missing the root importer's resolved llm-zoo version",
    ).toBeDefined();
    // pnpm suffixes the version with resolved peer deps, e.g.
    // "1.12.0(zod@4.4.3)"; strip that to get the plain semver.
    const resolvedVersion = rootLlmZoo!.version!.replace(/\(.*\)$/, '');

    // Strongest oracle: compare against the version pnpm actually installed
    // on disk, not just what the lockfile claims it resolved. This catches
    // any remaining lockfile-parsing mistake, not just the wrong-entry class
    // above. llm-zoo's `exports` map has no `./package.json` subpath, so
    // resolve it by walking the same node_modules search path Node itself
    // would use for the package's main entry point.
    const llmZooPackageJsonPath = (require.resolve.paths('llm-zoo') ?? [])
      .map((dir) => resolve(dir, 'llm-zoo', 'package.json'))
      .find((candidate) => existsSync(candidate));
    expect(
      llmZooPackageJsonPath,
      'could not resolve an installed llm-zoo/package.json',
    ).toBeDefined();
    const installedPackageJson = JSON.parse(
      readFileSync(llmZooPackageJsonPath!, 'utf8'),
    ) as { version?: string };
    expect(
      installedPackageJson.version,
      "pnpm-lock.yaml's resolved llm-zoo version does not match the " +
        'installed llm-zoo/package.json version',
    ).toBe(resolvedVersion);

    const relay = readRelayLlmZooVersion();

    expect(
      relay.version,
      `llm-zoo version skew: pnpm-lock.yaml resolves llm-zoo@${resolvedVersion} ` +
        `but relay deno.json pins ${relay.specifier}. Update ` +
        'supabase/functions/relay/deno.json (and refresh deno.lock) and/or ' +
        'the workspace pnpm-lock.yaml so both point to the same version.',
    ).toBe(resolvedVersion);
  });
});
