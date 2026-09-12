#!/usr/bin/env node
// Ratchet baseline integrity check (#11961). Every ratchet under
// config/ratchets/ is a file a PR can edit by hand, and each ratchet's own
// gate compares the tree against whatever the same PR committed — so a
// hand-edited ceiling reads as pre-existing. This check compares each
// committed baseline against the PR's BASE BRANCH copy
// (`git show <base>:config/ratchets/<file>`), where the owner ruling of
// 2026-09-06 applies: a ratchet baseline only ever shrinks.
//
// "Not wider" is structural, because each baseline has its own format:
//   - a number may only stay or fall (effect-migration per-file counts,
//     store-public-surface contract units);
//   - an array may only lose elements (knip findings, architecture edges,
//     host-agent import specifiers, mock sites, pure-tier suite lists);
//   - an object may only lose keys, recursing into shared ones;
//   - strings must match, except `semantics`, which is documentation and
//     legitimately changes with its owning script.
// A file rename is not growth: paths git detects as renamed
// (`git diff -M`) are mapped onto the base copy before comparing.
//
// The base ref comes from RATCHET_BASE_REF (CI sets it to the PR base sha),
// else GITHUB_BASE_REF as origin/<name>, else HEAD — so a local run with no
// CI base ref compares the working tree against the last commit, which still
// catches an uncommitted hand edit. A baseline file that does not exist on
// the base ref is new and not gated here; its owning ratchet gates it.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RATCHETS_DIR = join(rootDir, 'config', 'ratchets');
const RATCHETS_REL = 'config/ratchets';

function git(args, { allowFailure = false } = {}) {
  const result = execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'inherit'],
  });
  return result;
}

function resolveBaseRef() {
  const explicit = process.env.RATCHET_BASE_REF;
  if (explicit) {
    return { ref: explicit, source: 'RATCHET_BASE_REF', required: true };
  }
  const baseBranch = process.env.GITHUB_BASE_REF;
  if (baseBranch) {
    return { ref: `origin/${baseBranch}`, source: 'GITHUB_BASE_REF' };
  }
  return { ref: 'HEAD', source: 'fallback (no CI base ref)' };
}

function refExists(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      allowFailure: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Renames between the base ref and the working tree: [[oldPath, newPath]]. */
function detectRenames(baseRef) {
  const diff = git(['diff', '--name-status', '-M', baseRef, '--']);
  const renames = [];
  for (const line of diff.split('\n')) {
    const fields = line.split('\t');
    if (fields.length === 3 && fields[0].startsWith('R')) {
      renames.push([fields[1], fields[2]]);
    }
  }
  return renames;
}

/** Base-branch content of a baseline, with renamed paths mapped forward. */
function readBaseFile(baseRef, relPath, renames) {
  let text;
  try {
    text = git(['show', `${baseRef}:${relPath}`], { allowFailure: true });
  } catch {
    return null;
  }
  // Paths appear in baselines as JSON string tokens (object keys and array
  // elements), so replacing the quoted token is exact: a path that is a
  // prefix of another cannot collide inside the quotes.
  for (const [oldPath, newPath] of renames) {
    text = text.replaceAll(`"${oldPath}"`, `"${newPath}"`);
  }
  return text;
}

/** JSON.stringify with object keys sorted, for order-insensitive identity. */
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Append a violation for every way `work` is wider than `base`; return the
 * violations array. `path` is the JSON key path for messages.
 */
function compareNotWider(work, base, path, violations) {
  const fail = (reason) => violations.push({ path, reason, work, base });
  if (typeof work === 'number' && typeof base === 'number') {
    if (work > base) fail(`count rose from ${base} to ${work}`);
    return violations;
  }
  if (Array.isArray(work) && Array.isArray(base)) {
    const remaining = new Map();
    for (const element of base) {
      const key = canonical(element);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const element of work) {
      const key = canonical(element);
      const count = remaining.get(key) ?? 0;
      if (count === 0) {
        fail(`entry absent from the base baseline: ${key.slice(0, 200)}`);
      } else {
        remaining.set(key, count - 1);
      }
    }
    return violations;
  }
  if (
    work !== null &&
    base !== null &&
    typeof work === 'object' &&
    typeof base === 'object' &&
    !Array.isArray(work) &&
    !Array.isArray(base)
  ) {
    for (const [key, workValue] of Object.entries(work)) {
      if (key === 'semantics') continue;
      const childPath = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(base, key)) {
        violations.push({
          path: childPath,
          reason: 'key absent from the base baseline',
          work: workValue,
          base: undefined,
        });
        continue;
      }
      compareNotWider(workValue, base[key], childPath, violations);
    }
    return violations;
  }
  if (work !== base) {
    fail(
      `value changed from ${JSON.stringify(base)} to ${JSON.stringify(work)}`,
    );
  }
  return violations;
}

/** Fail the check itself if the comparator regresses. */
function selfTest() {
  const cases = [
    // Shrinkage passes: lower count, dropped key, dropped entry.
    [{ a: 1 }, { a: 2 }, 0],
    [{ a: 1 }, { a: 2, b: 5 }, 0],
    [[{ f: 'x' }], [{ f: 'x' }, { f: 'y' }], 0],
    // Growth fails: raised count, new key, new entry, changed string.
    [{ a: 3 }, { a: 2 }, 1],
    [{ a: 1, b: 1 }, { a: 1 }, 1],
    [[{ f: 'y' }], [{ f: 'x' }], 1],
    [{ s: 'new' }, { s: 'old' }, 1],
    // Array element order and object key order are not identity.
    [[{ b: 1, a: 2 }, 'z'], ['z', { a: 2, b: 1 }], 0],
    // The semantics string is documentation and exempt.
    [{ semantics: 'rewritten', n: 1 }, { semantics: 'old', n: 1 }, 0],
  ];
  for (const [work, base, expected] of cases) {
    const violations = compareNotWider(work, base, '', []);
    if (violations.length !== expected) {
      console.error(
        'compareNotWider self-test failed:',
        JSON.stringify({ work, base, expected, violations }),
      );
      process.exit(1);
    }
  }
}

function main() {
  selfTest();
  const { ref, source, required } = resolveBaseRef();
  if (!refExists(ref)) {
    if (required) {
      console.error(
        `Ratchet baseline check: base ref '${ref}' (from ${source}) is not a commit. ` +
          'Fetch the PR base before running this check.',
      );
      process.exit(1);
    }
    console.log(
      `Ratchet baseline check skipped: base ref '${ref}' (from ${source}) is unavailable.`,
    );
    return;
  }

  const renames = detectRenames(ref);
  const files = readdirSync(RATCHETS_DIR)
    .filter((name) => name.endsWith('.json'))
    .toSorted();
  let failed = false;
  for (const name of files) {
    const relPath = `${RATCHETS_REL}/${name}`;
    const baseText = readBaseFile(ref, relPath, renames);
    if (baseText == null) {
      console.log(`  ${name}: no baseline on ${ref} (new file; not gated)`);
      continue;
    }
    let base;
    try {
      base = JSON.parse(baseText);
    } catch (error) {
      console.error(
        `  ${name}: base copy at ${ref} is not parseable JSON: ${error.message}`,
      );
      failed = true;
      continue;
    }
    const work = JSON.parse(readFileSync(join(RATCHETS_DIR, name), 'utf8'));
    const violations = compareNotWider(work, base, '', []);
    if (violations.length > 0) {
      failed = true;
      console.error(
        `\n${name}: ${violations.length} widening(s) relative to ${ref}:`,
      );
      for (const { path, reason } of violations) {
        console.error(`  - ${path || '(root)'}: ${reason}`);
      }
    } else {
      console.log(`  ${name}: not wider than ${ref}`);
    }
  }

  if (failed) {
    console.error(
      '\nRatchet baseline check failed: a baseline under config/ratchets/ is wider than the base branch. ' +
        'Baselines are shrink-only (owner ruling 2026-09-06): lower counts and removed entries are always welcome; ' +
        'a raised count, a new entry, or a new key is a hand-edited ceiling and fails here even when the ratchet itself passes. ' +
        'A file rename is mapped onto the base copy automatically; if git did not detect yours as a rename, keep the old path in the diff. ' +
        'An intentional shape change (a new ratchet row or a new baseline file) updates this check in the same PR.',
    );
    process.exit(1);
  }
  console.log(
    `Ratchet baselines OK: ${files.length} file(s) no wider than ${ref} (${source}).`,
  );
}

main();
