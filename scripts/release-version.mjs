#!/usr/bin/env node
// What a release version is, and which channel it publishes to.
//
// A release version is `X.Y.Z` (stable) or `X.Y.Z-preview.N` with N from 1
// (a preview). Nothing else (`-beta`, `-rc`, `+build`) publishes anywhere.
//
// As a command it is the check each publishing job makes before publishing:
//
//   node scripts/release-version.mjs --tag <release-tag> \
//     --prefix <v|cli-v|sdk-v> --manifest <package.json> --prerelease <true|false>
//
// It fails unless the tag is the prefix plus the manifest's version and the
// GitHub pre-release flag agrees with the version's form, then appends
// `channel`, `npm_tag` and, for a `v` tag, `marketplace_version` to
// `$GITHUB_OUTPUT`. It needs only Node, so it runs before the workspace is
// installed.
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.([1-9]\d*))?$/;

// What a release tag puts before the version: `v` for the extension (the
// desktop installers share it), `cli-v` for the CLI, `sdk-v` for the llm and
// harness packages.
const TAG_PREFIXES = ['v', 'cli-v', 'sdk-v'];

/**
 * The parts of a release version, or undefined when `text` is not one.
 * `preview` is N for `X.Y.Z-preview.N` and undefined for a stable version.
 */
export function parseVersion(text) {
  const match = VERSION.exec(text);
  if (match == null) return undefined;
  const [, major, minor, patch, preview] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    preview: preview == null ? undefined : Number(preview),
  };
}

/** The version text of parts `parseVersion` returns. */
export function formatVersion(version) {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.preview == null ? base : `${base}-preview.${version.preview}`;
}

/** The channel a version publishes to, and the npm dist-tag of that channel. */
export function releaseChannel(version) {
  return version.preview == null
    ? { channel: 'stable', npmTag: 'latest' }
    : { channel: 'preview', npmTag: 'preview' };
}

// The VS Code Marketplace takes no semver prerelease suffix and tells a
// pre-release from a stable version only by version order: users who opted in
// get the highest version across both channels. So a preview of the
// even-minor train X.Y is packaged as the odd X.(Y+1).N, and from 1.0 on
// stable trains use even minors only, leaving each odd minor to the previews
// of the train before it.

/** Whether a stable train may use `minor` of `major`. */
const isStableMinor = (major, minor) => major < 1 || minor % 2 === 0;

/** The minor the stable train after `version`'s train starts at. */
export function nextTrainMinor({ major, minor }) {
  return isStableMinor(major, minor + 1) ? minor + 1 : minor + 2;
}

/** The version the Marketplace publishes `version` under; fails when it has none. */
function marketplaceVersion(version) {
  const { major, minor, patch, preview } = version;
  if (preview == null) {
    if (!isStableMinor(major, minor)) {
      fail(
        `Stable extension trains from 1.0 on use even minor numbers (odd minors are the Marketplace pre-release numbers of the previous train); '${formatVersion(version)}' cannot publish.`,
      );
    }
    return formatVersion(version);
  }
  if (patch !== 0 || minor % 2 === 1) {
    fail(
      `Previews are cut for the .0 of an even-minor train (X.Y.0-preview.N with Y even) so their Marketplace number X.(Y+1).N never collides with a stable version; '${formatVersion(version)}' cannot publish.`,
    );
  }
  return `${major}.${minor + 1}.${preview}`;
}

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function main() {
  const { tag, prefix, manifest, prerelease } = parseArgs({
    options: {
      tag: { type: 'string' },
      prefix: { type: 'string' },
      manifest: { type: 'string' },
      prerelease: { type: 'string' },
    },
  }).values;
  if (!TAG_PREFIXES.includes(prefix)) {
    fail(
      `--prefix must be one of ${TAG_PREFIXES.join(', ')}; got '${prefix}'.`,
    );
  }
  if (prerelease !== 'true' && prerelease !== 'false') {
    fail(`--prerelease must be true or false; got '${prerelease}'.`);
  }

  const versionText = JSON.parse(readFileSync(manifest, 'utf8')).version;
  if (tag !== `${prefix}${versionText}`) {
    fail(
      `Release tag '${tag}' does not match ${manifest} version '${versionText}' (expected '${prefix}${versionText}').`,
    );
  }
  const version = parseVersion(versionText);
  if (version == null) {
    fail(
      `Version '${versionText}' is neither X.Y.Z nor X.Y.Z-preview.N; nothing publishes it.`,
    );
  }

  // The flag and the form must agree, so a preview can never publish to the
  // stable channel by a missing flag, nor a stable version to the preview one.
  const { channel, npmTag } = releaseChannel(version);
  if (channel === 'preview' && prerelease !== 'true') {
    fail(
      `'${tag}' is a preview version but the GitHub release is not marked pre-release. Recreate it with 'gh release create --prerelease'.`,
    );
  }
  if (channel === 'stable' && prerelease === 'true') {
    fail(
      `'${tag}' is a stable version but the GitHub release is marked pre-release. Previews are '${prefix}X.Y.Z-preview.N'.`,
    );
  }

  const outputs = [`channel=${channel}`, `npm_tag=${npmTag}`];
  let summary = `Channel: ${channel} (${versionText}), npm dist-tag ${npmTag}`;
  if (prefix === 'v') {
    const marketplace = marketplaceVersion(version);
    outputs.push(`marketplace_version=${marketplace}`);
    summary += `, Marketplace ${channel === 'preview' ? 'pre-release ' : ''}${marketplace}`;
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  console.log(summary);
}

if (process.argv[1] === import.meta.filename) main();
