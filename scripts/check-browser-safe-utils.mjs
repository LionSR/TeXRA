#!/usr/bin/env node
// Drift guard for the hand-maintained `src/utils` browser-safety facts in
// CLAUDE.md and AGENTS.md.
//
// The guidance files document the total number of TypeScript modules under
// `src/utils/` and the exact set of `@utils/*` modules reachable from the
// webview frontends. This script recomputes both from the tree and compares
// them against BOTH guidance files, so a new file, a new frontend `@utils/*`
// import, a relative `./` import that pulls another utils module into the
// closure, or prose that drifts in either file all fail the check.
//
// Dependency-free (bare Node): the CI guidance-references job runs it without
// installing anything. Comments are stripped before scanning so JSDoc
// examples that mention `@utils/*` paths are not mistaken for real imports.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const utilsDir = join(rootDir, 'src', 'utils');
const frontendDirs = [
  'packages/extension/src/webview/frontend',
  'packages/extension/src/progressView/frontend',
  'packages/extension/src/settingsView/frontend',
].map((entry) => join(rootDir, entry));

// The canonical reachable set, kept in codepoint order and cross-checked
// against the enumerated list in both guidance files below.
const EXPECTED_REACHABLE = [
  '@utils/core',
  '@utils/core/boundedIdSet',
  '@utils/core/keyedMutex',
  '@utils/errors/errorMessage',
  '@utils/files/pastedImageName',
  '@utils/text/diff',
  '@utils/text/stringUtils',
];

const compareCodePoints = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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

/** Every module specifier in import/require/export-from positions. */
function importSpecifiers(text) {
  const stripped = stripComments(text);
  const specifiers = new Set();
  const pattern =
    /(?:from\s*|import\s*(?:\(\s*)?|require(?:\.resolve)?\s*\(\s*|import\.meta\.resolve\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of stripped.matchAll(pattern)) {
    specifiers.add(match[1]);
  }
  return specifiers;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve an `@utils/X` specifier to its on-disk source file, if any. */
function resolveUtilsFile(specifier) {
  const relativePath = specifier.slice('@utils/'.length);
  return [
    join(utilsDir, `${relativePath}.ts`),
    join(utilsDir, `${relativePath}.tsx`),
    join(utilsDir, relativePath, 'index.ts'),
    join(utilsDir, relativePath, 'index.tsx'),
  ].find(isFile);
}

/** Resolve a relative specifier against the file that imports it. */
function resolveRelativeFile(specifier, fromFile) {
  const base = resolve(dirname(fromFile), specifier);
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ].find(isFile);
}

/** Normalize an absolute `src/utils` file to its `@utils/...` specifier. */
function utilsSpecifierFor(file) {
  const rel = relative(utilsDir, file)
    .replaceAll('\\', '/')
    .replace(/\.tsx?$/, '');
  const withoutIndex = rel.replace(/\/index$/, '');
  return `@utils/${withoutIndex}`;
}

function isUnderUtilsDir(file) {
  return file === utilsDir || file.startsWith(`${utilsDir}/`);
}

function reachableUtils() {
  const reachable = new Set();
  const unresolvable = new Set();
  const queue = [];

  for (const dir of frontendDirs) {
    if (!existsSync(dir)) {
      console.error(`Frontend directory missing: ${relative(rootDir, dir)}`);
      process.exit(1);
    }
    for (const file of listSourceFiles(dir)) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('@utils/')) queue.push(specifier);
      }
    }
  }

  while (queue.length > 0) {
    const specifier = queue.pop();
    if (reachable.has(specifier)) continue;
    const file = resolveUtilsFile(specifier);
    if (file == null) {
      unresolvable.add(specifier);
      continue;
    }
    reachable.add(specifier);
    for (const next of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (next.startsWith('@utils/')) {
        queue.push(next);
      } else if (next.startsWith('.')) {
        const resolved = resolveRelativeFile(next, file);
        if (resolved != null && isUnderUtilsDir(resolved)) {
          queue.push(utilsSpecifierFor(resolved));
        }
      }
    }
  }

  return { reachable, unresolvable };
}

/** Backticked `@utils/*` specifiers in a documented enumeration. */
function documentedList(text, capturePattern) {
  const match = text.match(capturePattern);
  if (match == null) return null;
  return [...match[1].matchAll(/`(@utils\/[^`]+)`/g)].map((entry) => entry[1]);
}

/** Read every documented count and enumerated list from both guidance files. */
function documentedFacts() {
  const agents = readFileSync(join(rootDir, 'AGENTS.md'), 'utf8');
  const claude = readFileSync(join(rootDir, 'CLAUDE.md'), 'utf8');

  const agentsTotal = agents.match(
    /There are (\d+) TypeScript modules under `src\/utils\/`/,
  )?.[1];
  const agentsOther = agents.match(
    /the other (\d+) are not browser-reachable/,
  )?.[1];
  const claudeOther = claude.match(
    /The other (\d+)\s+TypeScript modules are not browser-reachable/,
  )?.[1];
  const claudeList = documentedList(
    claude,
    /browser-reachable today:\s*([\s\S]*?)\.\s*The other/,
  );
  const agentsList = documentedList(
    agents,
    /exactly \w+ modules are reachable from[\s\S]*?—\s*([\s\S]*?)\.\s*Those \w+/,
  );

  if (
    agentsTotal == null ||
    agentsOther == null ||
    claudeOther == null ||
    claudeList == null ||
    agentsList == null
  ) {
    console.error(
      'Could not locate one or more documented src/utils facts in AGENTS.md / CLAUDE.md.',
    );
    process.exit(1);
  }

  return {
    agentsTotal: Number(agentsTotal),
    agentsOther: Number(agentsOther),
    claudeOther: Number(claudeOther),
    claudeList,
    agentsList,
  };
}

function sameSet(a, b) {
  return (
    JSON.stringify([...a].toSorted(compareCodePoints)) ===
    JSON.stringify([...b].toSorted(compareCodePoints))
  );
}

function main() {
  const total = listSourceFiles(utilsDir).length;
  const facts = documentedFacts();
  const { reachable, unresolvable } = reachableUtils();
  const reachableSorted = [...reachable].toSorted(compareCodePoints);
  const expectedSorted = [...EXPECTED_REACHABLE].toSorted(compareCodePoints);
  const nonReachable = total - reachable.size;

  const errors = [];
  if (total !== facts.agentsTotal) {
    errors.push(
      `AGENTS.md total drifted: documented ${facts.agentsTotal}, actual ${total}`,
    );
  }
  if (nonReachable !== facts.agentsOther) {
    errors.push(
      `AGENTS.md non-reachable count drifted: documented ${facts.agentsOther}, actual ${nonReachable}`,
    );
  }
  if (nonReachable !== facts.claudeOther) {
    errors.push(
      `CLAUDE.md non-reachable count drifted: documented ${facts.claudeOther}, actual ${nonReachable}`,
    );
  }
  if (facts.agentsTotal !== facts.claudeOther + expectedSorted.length) {
    errors.push(
      `Cross-document total mismatch: AGENTS.md total ${facts.agentsTotal} != CLAUDE.md reachable (${expectedSorted.length}) + other (${facts.claudeOther})`,
    );
  }

  if (!sameSet(reachableSorted, expectedSorted)) {
    errors.push(
      `browser-reachable @utils set drifted:\n  documented: ${expectedSorted.join(', ')}\n  actual:     ${reachableSorted.join(', ')}`,
    );
  }
  for (const [name, list] of [
    ['CLAUDE.md', facts.claudeList],
    ['AGENTS.md', facts.agentsList],
  ]) {
    if (!sameSet(list, expectedSorted)) {
      errors.push(
        `${name} reachable list drifted:\n  documented: ${[...new Set(list)].toSorted(compareCodePoints).join(', ')}\n  expected:   ${expectedSorted.join(', ')}`,
      );
    }
  }

  if (unresolvable.size > 0) {
    errors.push(
      `unresolvable @utils/* specifiers: ${[...unresolvable].toSorted(compareCodePoints).join(', ')}`,
    );
  }

  if (errors.length > 0) {
    console.error('Browser-safe utils drift guard failed:');
    for (const error of errors) console.error(`  - ${error}`);
    console.error(
      'Update CLAUDE.md / AGENTS.md (and, if the reachable set changed, scripts/check-browser-safe-utils.mjs) to match the tree.',
    );
    process.exit(1);
  }

  console.log(
    `Browser-safe utils drift guard OK: ${total} total, ${reachable.size} reachable.`,
  );
}

main();
