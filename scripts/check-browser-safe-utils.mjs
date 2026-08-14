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
// installing anything. Comments and string/template literals are masked before
// import scanning so prose that merely mentions an import path is not mistaken
// for a real import.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const utilsDir = join(rootDir, 'src', 'utils');
const frontendDirs = [
  'packages/extension/src/webview/frontend',
  'packages/extension/src/progressView/frontend',
  'packages/extension/src/settingsView/frontend',
].map((entry) => join(rootDir, entry));

// The canonical reachable set, cross-checked against the enumerated list in
// both guidance files below.
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
const WORD_TO_NUMBER = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

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

/**
 * Byte ranges of comments and string/template literals. A regex match whose
 * start index falls inside one of these ranges is prose or a string value,
 * not code, so it cannot be a real import.
 */
function maskedRanges(text) {
  const ranges = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const char = text[i];
    if (char === '/' && text[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < n && text[i] !== '\n') i += 1;
      ranges.push([start, i]);
    } else if (char === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      ranges.push([start, i]);
    } else if (char === '"' || char === "'" || char === '`') {
      const start = i;
      const quote = char;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
        } else if (text[i] === quote) {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      ranges.push([start, i]);
    } else {
      i += 1;
    }
  }
  return ranges;
}

function insideRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** Every module specifier in import/require/export-from positions. */
function importSpecifiers(text) {
  const ranges = maskedRanges(text);
  const specifiers = new Set();
  const pattern =
    /(?:from\s*|import\s*(?:\(\s*)?|require(?:\.resolve)?\s*\(\s*|import\.meta\.resolve\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    if (insideRanges(match.index, ranges)) continue;
    specifiers.add(match[1]);
  }
  return specifiers;
}

function isTsFile(path) {
  return /\.tsx?$/.test(path) && isFile(path);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Candidate on-disk files for a specifier base, including NodeNext .js->.ts. */
function candidatesFor(base) {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  if (base.endsWith('.js') || base.endsWith('.jsx')) {
    const stem = base.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  return candidates;
}

/** Resolve an `@utils/X` specifier to its on-disk source file, if any. */
function resolveUtilsFile(specifier) {
  const relativePath = specifier.slice('@utils/'.length);
  return candidatesFor(join(utilsDir, relativePath)).find(isTsFile);
}

/** Resolve a relative specifier against the file that imports it. */
function resolveRelativeFile(specifier, fromFile) {
  const base = resolve(dirname(fromFile), specifier);
  return candidatesFor(base).find(isTsFile);
}

/** Normalize an absolute `src/utils` file to its `@utils/...` specifier. */
function utilsSpecifierFor(file) {
  const rel = relative(utilsDir, file)
    .replaceAll('\\', '/')
    .replace(/\.tsx?$/, '');
  const withoutIndex = rel.replace(/\/index$/, '');
  return `@utils/${withoutIndex}`;
}

/** Platform-independent containment check against the src/utils directory. */
function isUnderUtilsDir(file) {
  const rel = relative(utilsDir, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
  const claudeReachableWord = claude.match(
    /Exactly (\w+)\s+modules are browser-reachable today/,
  )?.[1];
  const agentsReachableWord = agents.match(
    /exactly (\w+) modules are reachable from/,
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
    claudeReachableWord == null ||
    agentsReachableWord == null ||
    claudeList == null ||
    agentsList == null
  ) {
    console.error(
      'Could not locate one or more documented src/utils facts in AGENTS.md / CLAUDE.md.',
    );
    process.exit(1);
  }

  const claudeReachable = WORD_TO_NUMBER[claudeReachableWord.toLowerCase()];
  const agentsReachable = WORD_TO_NUMBER[agentsReachableWord.toLowerCase()];
  if (claudeReachable == null || agentsReachable == null) {
    console.error(
      'Could not parse the documented reachable-module count words.',
    );
    process.exit(1);
  }

  return {
    agentsTotal: Number(agentsTotal),
    agentsOther: Number(agentsOther),
    claudeOther: Number(claudeOther),
    claudeReachable,
    agentsReachable,
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
  if (facts.agentsReachable !== reachable.size) {
    errors.push(
      `AGENTS.md reachable count drifted: documented ${facts.agentsReachable}, actual ${reachable.size}`,
    );
  }
  if (facts.claudeReachable !== reachable.size) {
    errors.push(
      `CLAUDE.md reachable count drifted: documented ${facts.claudeReachable}, actual ${reachable.size}`,
    );
  }
  if (facts.agentsTotal !== facts.claudeReachable + facts.claudeOther) {
    errors.push(
      `Cross-document total mismatch: AGENTS.md total ${facts.agentsTotal} != CLAUDE.md reachable (${facts.claudeReachable}) + other (${facts.claudeOther})`,
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
