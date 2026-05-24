#!/usr/bin/env node

// Node.js imports
import fs from 'node:fs';
import process from 'node:process';

const MANIFEST_PATHS = [
  'package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/desktop/package.json',
  'packages/extension/package.json',
];

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

// Release trains use patch values 0 through 10; after .10, development moves
// to the next minor train.
const MAX_PATCH_VERSION = 10;

function printUsage() {
  console.error(
    [
      'Usage:',
      '  node scripts/bump-workspace-version.mjs --from <release-tag> [--check]',
      '  node scripts/bump-workspace-version.mjs --version <version> [--check]',
      '',
      'Examples:',
      '  node scripts/bump-workspace-version.mjs --from v0.37.10',
      '  node scripts/bump-workspace-version.mjs --version 0.38.0 --check',
    ].join('\n'),
  );
}

function fail(message) {
  console.error(message);
  printUsage();
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    check: false,
    from: undefined,
    version: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--check') {
      args.check = true;
      continue;
    }

    if (arg === '--from' || arg === '--version') {
      const value = argv[index + 1];
      if (value == null || value.startsWith('--')) {
        fail(`${arg} requires a value.`);
      }
      args[arg.slice(2)] = value;
      index += 1;
      continue;
    }

    fail(`Unknown argument: ${arg}`);
  }

  if ((args.from == null) === (args.version == null)) {
    fail('Pass exactly one of --from or --version.');
  }

  return args;
}

function parseVersion(rawVersion, label) {
  const match = VERSION_PATTERN.exec(rawVersion);
  if (match == null) {
    fail(`${label} must be MAJOR.MINOR.PATCH, with an optional leading v.`);
  }

  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function nextWorkspaceVersion(rawVersion) {
  const version = parseVersion(rawVersion, 'Release tag');

  if (version.patch >= MAX_PATCH_VERSION) {
    return formatVersion({
      major: version.major,
      minor: version.minor + 1,
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

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
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
    const manifest = readManifest(manifestPath);

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
