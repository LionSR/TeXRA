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
 *
 * Known limitation: a template literal is masked as one unit, including any
 * `${...}` substitution. Dynamic imports nested inside a template substitution
 * are therefore not traversed. That pattern does not occur in the current
 * frontends or reachable utils; if it ever does, the webview build itself will
 * fail on the resulting Node builtin, so this is a guard gap rather than a
 * silent build risk.
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

/**
 * True when the matched specifier is erased by TypeScript (`import type` /
 * `export type ... from` / a named import whose every binding is `type Foo`).
 * Mixed `{ type X, y }` stays reachable because `y` is a value import.
 * A binding named `type` (`import { type }` / `import { type as value }`) is
 * a value import — TypeScript treats `type` followed by `as` as the name.
 * `type as as Alias` is type-only: `type` is the modifier and `as` is the name.
 * `binding` is escape-decoded, so an identifier may start with any Unicode
 * ID_Start code point (`É`, `\u00c9` decoded, ...), not only ASCII.
 */
function isTypeOnlyBinding(binding) {
  // `type as as Alias` is a type-only import of the name `as`.
  if (/^type\s+as\s+as\s+[\p{ID_Start}$_]/u.test(binding)) return true;
  // `type as value` imports a runtime binding named `type`.
  // `type as` / `type as,` is a type-only import of the name `as`.
  if (/^type\s+as\s+[\p{ID_Start}$_]/u.test(binding)) return false;
  return /^type\s+[\p{ID_Start}$_]/u.test(binding);
}

/** Blank comment ranges so they cannot change binding classification. */
function withoutComments(text) {
  const ranges = maskedRanges(text);
  let result = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    const chunk = text.slice(start, end);
    if (chunk.startsWith('//') || chunk.startsWith('/*')) {
      result += text.slice(cursor, start) + ' '.repeat(end - start);
      cursor = end;
    }
  }
  return result + text.slice(cursor);
}

/**
 * Decode `\uXXXX` / `\u{...}` identifier escapes. TypeScript decodes these
 * before parsing, so `\u00c9` and `É` are the same identifier and an escaped
 * `\u0074ype` / `\u0061s` still acts as the `type` / `as` keyword. Out-of-
 * range escapes are kept verbatim; that code does not compile anyway.
 */
function decodeIdentifierEscapes(text) {
  return text
    .replace(/\\u\{([0-9A-Fa-f]+)\}/g, (sequence, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : sequence;
    })
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_sequence, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

function precedingUnmaskedClause(text, matchIndex, ranges) {
  const before = text.slice(0, matchIndex);
  let keywordIndex = -1;
  for (const keyword of before.matchAll(/\b(?:import|export)\b/g)) {
    if (!insideRanges(keyword.index, ranges)) {
      keywordIndex = keyword.index;
    }
  }
  return keywordIndex < 0 ? '' : before.slice(keywordIndex);
}

function isTypeOnlySpecifier(text, match, ranges) {
  const matched = match[0];
  // `import type X = require('...')` is erased. A bare require() is not.
  if (/^require/.test(matched)) {
    const clause = decodeIdentifierEscapes(
      withoutComments(precedingUnmaskedClause(text, match.index, ranges)),
    );
    return /^(?:import|export)\s+type\s+[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*\s*=\s*$/u.test(
      clause,
    );
  }
  if (/^(?:import\s*\(|import\.meta\.resolve)/.test(matched)) {
    return false;
  }
  // Bare side-effect `import 'x'` is always a value edge. Its match includes
  // the `import` keyword, so looking backward would see the previous clause.
  if (/^import\s*['"]/.test(matched)) {
    return false;
  }
  if (!/^from\b/.test(matched)) {
    return false;
  }

  const clause = decodeIdentifierEscapes(
    withoutComments(precedingUnmaskedClause(text, match.index, ranges)),
  );
  if (clause.length === 0) return false;
  // `import type from` is a default binding named `type`. Type-only needs a
  // specifier after `type` (`{`, `*`, or a name). Blanked comments are spaces,
  // so `import /* c */ type from` stays a value import. The name check uses
  // ID_Start on escape-decoded text, so `import type É from` stays type-only.
  if (
    /^(?:import|export)\s+type(?:\s+[\p{ID_Start}$_]|\s*[{*])/u.test(clause)
  ) {
    return true;
  }
  const named = clause.match(/^(?:import|export)\s*\{([^}]*)\}\s*$/);
  if (named == null) return false;
  const bindings = named[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return bindings.length > 0 && bindings.every(isTypeOnlyBinding);
}

/** Every module specifier in import/require/export-from positions. */
function importSpecifiers(text) {
  const ranges = maskedRanges(text);
  const specifiers = new Set();
  const pattern =
    /(?:from\s*|import\s*(?:\(\s*)?|require(?:\.resolve)?\s*\(\s*|import\.meta\.resolve\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    if (insideRanges(match.index, ranges)) continue;
    if (isTypeOnlySpecifier(text, match, ranges)) continue;
    specifiers.add(match[1]);
  }
  return specifiers;
}

/** Fail the guard itself if type-only detection regresses. */
function selfTestImportSpecifiers() {
  const cases = [
    {
      text: "import type { X } from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import type X from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import type * as ns from './typeOnly';\n",
      expected: [],
    },
    {
      text: "export type * from './typeOnly';\n",
      expected: [],
    },
    {
      text: "export type { X } from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import { type X } from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import {\n  type X,\n} from './typeOnly';\n",
      expected: [],
    },
    {
      text: "export { type X } from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import { type X, y } from './mixed';\n",
      expected: ['./mixed'],
    },
    {
      text: "import { y } from './value';\n",
      expected: ['./value'],
    },
    {
      text: "import './side-effect';\n",
      expected: ['./side-effect'],
    },
    {
      text: "import type { X } from './typeOnly';\nimport './side-effect';\n",
      expected: ['./side-effect'],
    },
    {
      text: "import { type } from './value';\n",
      expected: ['./value'],
    },
    {
      text: "import { type as value } from './value';\n",
      expected: ['./value'],
    },
    {
      text: "import { type as } from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import { type as as Value } from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import type É from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import type \\u00C9 from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import { type É } from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import { \\u0074ype X } from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import type É = require('./typeOnly');\n",
      expected: [],
    },
    {
      text: "import { type as É } from './value';\n",
      expected: ['./value'],
    },
    {
      text: "import { type \\u0061s value } from './value';\n",
      expected: ['./value'],
    },
    {
      text: "import type from './value';\n",
      expected: ['./value'],
    },
    {
      text: "import /* note */ type from './value';\n",
      expected: ['./value'],
    },
    {
      text: "import /* note */ type { X } from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import { /* public shape */ type X } from './typeOnly';\n",
      expected: [],
    },
    {
      text: "import { y /* import type */ } from './value';\n",
      expected: ['./value'],
    },
    {
      text: "import type Utils = require('./typeOnly');\n",
      expected: [],
    },
    {
      text: "import Utils = require('./value');\n",
      expected: ['./value'],
    },
    {
      text: "const x = require('./value');\n",
      expected: ['./value'],
    },
    {
      text: `${'import type {\n'}  ${'A,\n'.repeat(80)}} from './typeOnly';\n`,
      expected: [],
    },
  ];
  for (const { text, expected } of cases) {
    const actual = [...importSpecifiers(text)].toSorted(compareCodePoints);
    const wanted = [...expected].toSorted(compareCodePoints);
    if (!sameSet(actual, wanted)) {
      console.error(
        'importSpecifiers self-test failed:',
        JSON.stringify({ text, actual, expected: wanted }),
      );
      process.exit(1);
    }
  }
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
  if (base.endsWith('.js')) {
    const stem = base.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  } else if (base.endsWith('.jsx')) {
    const stem = base.slice(0, -4);
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
  selfTestImportSpecifiers();
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
