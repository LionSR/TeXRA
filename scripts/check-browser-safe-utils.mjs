#!/usr/bin/env node
// Drift guard for the hand-maintained `src/utils` browser-safety counts in
// CLAUDE.md and AGENTS.md.
//
// Two facts are documented there and used to rot because nothing compiles
// them: the total number of TypeScript modules under `src/utils/`, and the
// exact set of `@utils/*` modules reachable from the webview frontends.
// This script recomputes both from the tree and fails when they no longer
// match, so adding a file to `src/utils/` or importing a new `@utils/*`
// module from a frontend becomes a failed check instead of stale prose.
//
// Dependency-free (bare Node): the CI guidance-references job runs it without
// installing anything. It strips comments before scanning so JSDoc examples
// that mention `@utils/*` paths are not mistaken for real imports.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const utilsDir = join(rootDir, 'src', 'utils');
const frontendDirs = [
  'packages/extension/src/webview/frontend',
  'packages/extension/src/progressView/frontend',
  'packages/extension/src/settingsView/frontend',
].map((entry) => join(rootDir, entry));

const EXPECTED_REACHABLE = [
  '@utils/core',
  '@utils/core/boundedIdSet',
  '@utils/errors/errorMessage',
  '@utils/files/pastedImageName',
  '@utils/text/diff',
  '@utils/text/stringUtils',
];
/** Recursive list of TypeScript source files under a directory. */
function listSourceFiles(dir) {
  const results = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results;
}

/** Strip line and block comments while respecting string/template literals. */
function stripComments(text) {
  let output = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (quote !== null) {
      output += char;
      if (char === '\\') {
        output += next ?? '';
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      output += char;
      i += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }
    output += char;
    i += 1;
  }
  return output;
}

/** Every `@utils/*` specifier in import/require/export-from positions. */
function utilsSpecifiers(text) {
  const stripped = stripComments(text);
  const specifiers = new Set();
  const importPattern =
    /(?:from\s*|import\s*(?:\(\s*)?|require(?:\.resolve)?\s*\(\s*|import\.meta\.resolve\s*\(\s*)['"](@utils\/[^'"]+)['"]/g;
  for (const match of stripped.matchAll(importPattern)) {
    specifiers.add(match[1]);
  }
  return specifiers;
}

/** Resolve an `@utils/X` specifier to its on-disk `.ts` file, if any. */
function resolveUtilsFile(specifier) {
  const relativePath = specifier.slice('@utils/'.length);
  const candidates = [
    join(utilsDir, `${relativePath}.ts`),
    join(utilsDir, relativePath, 'index.ts'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function scanFile(file) {
  return utilsSpecifiers(readFileSync(file, 'utf8'));
}

/** Extract the documented total and non-reachable counts from guidance prose. */
function documentedCounts() {
  const agents = readFileSync(join(rootDir, 'AGENTS.md'), 'utf8');
  const claude = readFileSync(join(rootDir, 'CLAUDE.md'), 'utf8');
  const total = agents.match(
    /There are (\d+) TypeScript modules under `src\/utils\/`/,
  )?.[1];
  const other = claude.match(
    /The other (\d+)\s+TypeScript modules are not browser-reachable/,
  )?.[1];
  if (total == null || other == null) {
    console.error(
      'Could not locate the documented src/utils counts in AGENTS.md / CLAUDE.md.',
    );
    process.exit(1);
  }
  return { total: Number(total), other: Number(other) };
}

function main() {
  const total = listSourceFiles(utilsDir).length;
  const documented = documentedCounts();

  const reachable = new Set();
  const queue = [];
  for (const dir of frontendDirs) {
    if (!existsSync(dir)) {
      console.error(`Frontend directory missing: ${relative(rootDir, dir)}`);
      process.exit(1);
    }
    for (const file of listSourceFiles(dir)) {
      for (const specifier of scanFile(file)) queue.push(specifier);
    }
  }
  while (queue.length > 0) {
    const specifier = queue.pop();
    if (reachable.has(specifier)) continue;
    const file = resolveUtilsFile(specifier);
    if (file == null) continue; // A frontend may reference a non-utils module via @utils alias edge case.
    reachable.add(specifier);
    for (const next of scanFile(file)) queue.push(next);
  }

  const reachableSorted = [...reachable].toSorted((a, b) => a.localeCompare(b));
  const errors = [];
  if (total !== documented.total) {
    errors.push(
      `src/utils total drifted: documented ${documented.total}, actual ${total}`,
    );
  }
  if (total - reachable.size !== documented.other) {
    errors.push(
      `src/utils non-reachable count drifted: documented ${documented.other}, actual ${total - reachable.size}`,
    );
  }
  if (JSON.stringify(reachableSorted) !== JSON.stringify(EXPECTED_REACHABLE)) {
    errors.push(
      `browser-reachable @utils set drifted:\n  documented: ${EXPECTED_REACHABLE.join(', ')}\n  actual:     ${reachableSorted.join(', ')}`,
    );
  }
  for (const specifier of EXPECTED_REACHABLE) {
    for (const doc of ['AGENTS.md', 'CLAUDE.md']) {
      if (!readFileSync(join(rootDir, doc), 'utf8').includes(specifier)) {
        errors.push(`${specifier} is missing from ${doc}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('Browser-safe utils drift guard failed:');
    for (const error of errors) console.error(`  - ${error}`);
    console.error(
      'Update CLAUDE.md / AGENTS.md and scripts/check-browser-safe-utils.mjs to match the new tree.',
    );
    process.exit(1);
  }

  console.log(
    `Browser-safe utils drift guard OK: ${total} total, ${reachableSorted.length} reachable.`,
  );
}

main();
