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
// The import scan parses each file with the TypeScript compiler API (the
// repo's `typescript` devDependency) rather than lexing with regexes, so a
// comment or string literal that merely mentions an import path, an
// identifier lookalike such as `myimport(...)` / `loader.require(...)`, and
// a type-only edge all classify the way the compiler sees them. The ungated
// guidance-references CI job installs devDependencies before running it.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

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
 * Specifier text of a statically resolvable argument: a quoted string
 * literal, or a template literal with no substitutions (a backticked
 * argument without a `${...}` substitution is as static as a quoted string).
 * Identifiers and substituted templates are not statically resolvable, so
 * they contribute no edge.
 */
function staticSpecifierText(node) {
  if (
    ts.isStringLiteral(node) ||
    node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return node.text;
  }
  return null;
}

/**
 * The runtime module specifier a node contributes, or null when the node is
 * not a dependency edge.
 *
 * Type-only edges are erased by the compiler, so they contribute nothing:
 * `import type ...`, `export type ... from`, a named list with no default
 * binding whose every binding is `type`-marked (`import { type X }`), and
 * `import type X = require(...)`.
 * The parser's `isTypeOnly` flags own the awkward grammar — `{ type as }`
 * imports the name `as` type-only, `{ type as v }` aliases a value named
 * `type`, an escaped `\u0074ype` still parses as the modifier, and Unicode
 * names classify identically — so nothing here re-implements it. An empty
 * `{}` list is a side-effect edge and stays reachable.
 *
 * Call forms counted: dynamic `import(...)`, bare `require(...)`,
 * `require.resolve(...)`, and `import.meta.resolve(...)`. Property-access
 * lookalikes such as `loader.require(...)` are not module dependencies, and
 * type-position `import('...')` (an ImportType node, not a CallExpression)
 * is erased, so neither produces an edge.
 */
function dependencySpecifier(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause != null) {
      if (clause.isTypeOnly) return null;
      const named = clause.namedBindings;
      if (
        clause.name == null &&
        named != null &&
        ts.isNamedImports(named) &&
        named.elements.length > 0 &&
        named.elements.every((element) => element.isTypeOnly)
      ) {
        return null;
      }
    }
    return staticSpecifierText(node.moduleSpecifier);
  }
  if (ts.isExportDeclaration(node)) {
    if (node.moduleSpecifier == null || node.isTypeOnly) return null;
    const named = node.exportClause;
    if (
      named != null &&
      ts.isNamedExports(named) &&
      named.elements.length > 0 &&
      named.elements.every((element) => element.isTypeOnly)
    ) {
      return null;
    }
    return staticSpecifierText(node.moduleSpecifier);
  }
  if (ts.isImportEqualsDeclaration(node)) {
    if (node.isTypeOnly) return null;
    const reference = node.moduleReference;
    return ts.isExternalModuleReference(reference)
      ? staticSpecifierText(reference.expression)
      : null;
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const callee = node.expression;
    const isDependencyCall =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === 'require') ||
      (ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'require' &&
        callee.name.text === 'resolve') ||
      (ts.isPropertyAccessExpression(callee) &&
        callee.expression.kind === ts.SyntaxKind.MetaProperty &&
        callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        callee.name.text === 'resolve');
    if (isDependencyCall) {
      return staticSpecifierText(node.arguments[0]);
    }
  }
  return null;
}

/**
 * Every runtime module specifier in import/require/export-from positions.
 * Parsing instead of lexing means a comment between a keyword and its
 * specifier, a regex literal containing a quote, and a template-literal
 * `${...}` substitution all behave the way the compiler sees them.
 */
function importSpecifiers(text, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
  );
  const specifiers = new Set();
  const visit = (node) => {
    const specifier = dependencySpecifier(node);
    if (specifier != null) specifiers.add(specifier);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** Fail the guard itself if specifier classification regresses. */
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
      text: "import value, { type helper } from './mixed';\n",
      expected: ['./mixed'],
    },
    {
      text: "import value, { type X, type Y } from './mixed';\n",
      expected: ['./mixed'],
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
    // Gap coverage from #10213: constructs the regex scanner misclassified.
    {
      text: "myimport('@utils/x');\n",
      expected: [],
    },
    {
      text: "loader.require('@utils/x');\n",
      expected: [],
    },
    {
      text: "registry.import('./value');\n",
      expected: [],
    },
    {
      text: "import /* note */ '@utils/x';\n",
      expected: ['@utils/x'],
    },
    {
      text: "import // note\n'./value';\n",
      expected: ['./value'],
    },
    {
      text: 'import(/* webpackChunkName: "chunk" */ \'@utils/x\');\n',
      expected: ['@utils/x'],
    },
    {
      text: "require(/* note */ './value');\n",
      expected: ['./value'],
    },
    {
      text: "const quote = /foo'/g;\nimport './value';\n",
      expected: ['./value'],
    },
    {
      text: "const url = `${import('./value')}`;\n",
      expected: ['./value'],
    },
    {
      text: "import('./value');\n",
      expected: ['./value'],
    },
    {
      text: 'import(`./value`);\n',
      expected: ['./value'],
    },
    {
      text: "import.meta.resolve('./value');\n",
      expected: ['./value'],
    },
    {
      text: "require.resolve('./value');\n",
      expected: ['./value'],
    },
    {
      text: "type Env = import('./typeOnly').Environment;\n",
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
      for (const specifier of importSpecifiers(
        readFileSync(file, 'utf8'),
        file,
      )) {
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
    for (const next of importSpecifiers(readFileSync(file, 'utf8'), file)) {
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
