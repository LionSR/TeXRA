#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { parseArgs as parseNodeArgs } from 'node:util';

import semver from 'semver';

import { readJson } from './extension-package-utils.mjs';

// The app's manifests. `@texra-ai/harness` and `@texra-ai/llm` are versioned
// on their own, as the npm packages they are, so a release leaves them be.
const MANIFEST_PATHS = [
  'package.json',
  'packages/cli/package.json',
  'packages/desktop/package.json',
  'packages/extension/package.json',
  'packages/texra/package.json',
];

// Accept the canonical extension tag (`v0.38.9`), the CLI tag (`cli-v0.38.9`),
// and a bare version (`0.38.9`). Release tags are cut in pairs off the same
// commit, so either tag resolves to the same next version.
const RELEASE_TAG_PREFIX = /^(?:cli-v|v)/;

// The only prerelease form the release channel accepts: `X.Y.Z-preview.N`
// (see `.claude/skills/releasing/SKILL.md`, "Preview releases"). The
// identifier is fixed so that every workflow can tell a preview from a stable
// version with one regex, and so nothing else (`-beta`, `-rc`) can slip onto
// the preview npm dist-tag or the Marketplace pre-release channel by accident.
const PRERELEASE_ID = 'preview';

// Release trains use patch values 0 through 10; after .10, development moves
// to the next minor train. From 1.0 on that rollover must land on an even
// minor: odd minors are the Marketplace pre-release numbers of the previous
// train (see release.yml's publish gate), so a 1.x rollover skips one.
const MAX_PATCH_VERSION = 10;

const OPTIONS = {
  check: { type: 'boolean', default: false },
  from: { type: 'string' },
  version: { type: 'string' },
};

function printUsage() {
  console.error(
    [
      'Usage:',
      '  node scripts/bump-workspace-version.mjs --from <release-tag> [--check]',
      '  node scripts/bump-workspace-version.mjs --version <version> [--check]',
      '',
      'Examples:',
      '  node scripts/bump-workspace-version.mjs --from v0.37.10',
      '  node scripts/bump-workspace-version.mjs --from cli-v0.37.10',
      '  node scripts/bump-workspace-version.mjs --from v1.0.0-preview.1',
      '  node scripts/bump-workspace-version.mjs --version 0.38.0 --check',
      '  node scripts/bump-workspace-version.mjs --version 1.0.0-preview.2',
    ].join('\n'),
  );
}

function fail(message) {
  console.error(message);
  printUsage();
  process.exit(1);
}

function parseArgs(argv) {
  // Strict: an unknown flag (a `-check` typo included) or a stray positional
  // fails loudly instead of falling through.
  let args;
  try {
    ({ values: args } = parseNodeArgs({ args: argv, options: OPTIONS }));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if ((args.from == null) === (args.version == null)) {
    fail('Pass exactly one of --from or --version.');
  }

  return args;
}

function parseVersion(rawVersion, label) {
  const stripped = rawVersion.replace(RELEASE_TAG_PREFIX, '');
  const parsed = semver.parse(stripped);
  // Accept a bare MAJOR.MINOR.PATCH or the one prerelease form the release
  // channel knows, `MAJOR.MINOR.PATCH-preview.N`. Reject everything else:
  // semver.parse would otherwise accept (and the manifests would then carry)
  // suffixes like "-beta" or "+build" that no publish job routes anywhere.
  const preview =
    parsed != null &&
    parsed.prerelease.length === 2 &&
    parsed.prerelease[0] === PRERELEASE_ID &&
    Number.isInteger(parsed.prerelease[1]) &&
    parsed.prerelease[1] >= 1
      ? parsed.prerelease[1]
      : undefined;
  const isAccepted =
    parsed != null &&
    parsed.build.length === 0 &&
    (parsed.prerelease.length === 0 || preview != null);
  if (!isAccepted) {
    fail(
      `${label} must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-${PRERELEASE_ID}.N, with an optional leading v or cli-v prefix.`,
    );
  }

  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    preview,
  };
}

function formatVersion(version) {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.preview == null
    ? base
    : `${base}-${PRERELEASE_ID}.${version.preview}`;
}

function nextWorkspaceVersion(rawVersion) {
  const version = parseVersion(rawVersion, 'Release tag');

  // A preview's successor is the next preview of the same version. The
  // version-bump workflow never fires on a preview release, so this branch
  // only serves the maintainer setting up the next preview by hand.
  if (version.preview != null) {
    return formatVersion({ ...version, preview: version.preview + 1 });
  }

  if (version.patch >= MAX_PATCH_VERSION) {
    // Stable tags from 1.0 are even-minor only (release.yml refuses odd-minor
    // stable versions), so the rollover steps over the pre-release minor.
    return formatVersion({
      major: version.major,
      minor: version.minor + (version.major >= 1 ? 2 : 1),
      patch: 0,
    });
  }

  return formatVersion({
    ...version,
    patch: version.patch + 1,
  });
}

function normalizeVersion(rawVersion) {
  return formatVersion(parseVersion(rawVersion, 'Version'));
}

function writeManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const newVersion =
    args.version == null
      ? nextWorkspaceVersion(args.from)
      : normalizeVersion(args.version);

  const mismatches = [];

  for (const manifestPath of MANIFEST_PATHS) {
    const manifest = readJson(manifestPath);

    if (args.check) {
      if (manifest.version !== newVersion) {
        mismatches.push(
          `${manifestPath}: expected ${newVersion}, found ${manifest.version}`,
        );
      }
      continue;
    }

    manifest.version = newVersion;
    writeManifest(manifestPath, manifest);
  }

  if (mismatches.length > 0) {
    console.error(mismatches.join('\n'));
    process.exit(1);
  }

  process.stdout.write(`${newVersion}\n`);
}

main();
