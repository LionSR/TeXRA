#!/usr/bin/env node
// Effect migration ratchet — Phase 1 of
// docs/prds/2026-08-26-effect-4-runtime-migration.md, "Execution strategy"
// rule 3: leftovers fail CI, not review.
//
// Counts, per production file, the mechanisms the migration retires and
// freezes them in config/ratchets/effect-migration-baseline.json as counts
// that may only shrink: `platform()` reads, `setServices()` calls,
// `new AbortController(` constructions, imports of the superseded
// concurrency/error packages, `Effect.run*` boundary calls (rule R1), and
// raw catch clauses in files that already import `effect` at runtime (rule
// R7). Every row is a per-file allowlist: a file absent from a row fails on
// its first site. A separate hard check expires `@adapter-until YYYY-MM-DD`
// markers on temporary adapters: it validates the date and fails once it has
// passed, but it cannot detect an adapter added without a marker, since
// "temporary adapter" is not mechanically recognizable; presence stays a
// review obligation. The PR that zeroes a row deletes the row.
//
// Files are parsed with the TypeScript compiler API (the repo's `typescript`
// devDependency, as scripts/check-browser-safe-utils.mjs does) rather than
// grepped, so a comment or string literal that merely mentions `platform()`,
// a getter that happens to be named `runPromise`, or a `./delay` relative
// import classify the way the compiler sees them. The `@adapter-until`
// markers live in comments, so that scan is textual by design.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { walkFiles } from './walkFiles.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(
  rootDir,
  'config',
  'ratchets',
  'effect-migration-baseline.json',
);
const PRD = 'docs/prds/2026-08-26-effect-4-runtime-migration.md';

const SUPERSEDED_PACKAGES = [
  'p-queue',
  'p-map',
  'p-retry',
  'p-timeout',
  'p-defer',
  'async-mutex',
  'delay',
  'neverthrow',
];
const PLATFORM_MODULE = '@platform/platform';
const PLATFORM_MODULE_PATH = 'src/platform/platform';
const RUN_BOUNDARY_NAMES = new Set([
  'runPromise',
  'runPromiseExit',
  'runSync',
  'runFork',
  'runCallback',
]);

const ROW_PLATFORM = 'platform()';
const ROW_SET_SERVICES = 'setServices()';
const ROW_ABORT_CONTROLLER = 'new AbortController()';
const ROW_RUN_BOUNDARY = 'Effect.run*';
const ROW_CATCH = 'catch:effect-importer';
const importRow = (pkg) => `import:${pkg}`;

/**
 * Baseline rows in output order. Every row is a per-file allowlist of
 * shrink-only counts: a file absent from a row fails on its first site, and
 * a listed count may only stay or fall. `rule` is the PRD rule a failure
 * cites.
 */
const ROWS = [
  {
    id: ROW_PLATFORM,
    rule: `${PRD} goal 3 / R2: the global platform() reader is being retired; new code receives its services as inputs instead of reading the ambient locator`,
  },
  {
    id: ROW_SET_SERVICES,
    rule: `${PRD} Phase 2 / §11: zero production setServices() calls; run services are supplied once at the flow boundary, not copied into nodes`,
  },
  {
    id: ROW_ABORT_CONTROLLER,
    rule: `${PRD} R5: interruption replaces internal abort choreography; an AbortController is adapted only where an external SDK or host API requires a signal`,
  },
  ...SUPERSEDED_PACKAGES.map((pkg) => ({
    id: importRow(pkg),
    rule: `${PRD} §11 Simplification: '${pkg}' is superseded by the Effect primitive for the same mechanism (§2.5 idiom table); do not add a new importer`,
  })),
  {
    id: ROW_RUN_BOUNDARY,
    rule: `${PRD} R1: Effect inside, Promises at the boundary — Effect.run* is forbidden below the named boundary modules; a new boundary module is added deliberately by regenerating the baseline in the same PR, with the justification in the PR body`,
  },
  {
    id: ROW_CATCH,
    rule: `${PRD} R7 and execution rule 2 (one pass per file): a file that imports 'effect' converts its catch sites in the same pass — typed recovery, scope finalizers, or Exit folds; a raw catch remains only inside a named foreign-runtime adapter`,
  },
];

const SEMANTICS =
  'Per-file counts of the mechanisms the Effect 4 migration retires (docs/prds/2026-08-26-effect-4-runtime-migration.md, execution rule 3), owned by scripts/check-effect-migration-ratchet.mjs. ' +
  'Scope: *.ts and *.tsx under src/ and packages/*/src/, excluding src/test-kernel/, *.vitest.ts, and any dist/ or node_modules/ directory (packages/*/scripts and packages/*/tests are outside the scanned roots). ' +
  'Files are parsed with the TypeScript compiler API, so comments and string literals never count. ' +
  "Rows: 'platform()' counts calls of the platform export of @platform/platform (src/platform/platform.ts) under whatever local name the file binds it to — `import { platform as p }` then p(), and `import * as P` then P.platform(), included; tryPlatform and unrelated bindings such as node:os platform excluded; 'setServices()' counts calls whose callee is setServices or ends in .setServices; 'new AbortController()' counts new-expressions on the identifier AbortController; " +
  "'import:<pkg>' counts import/export-from/import-equals/require()/import() specifiers exactly equal to the package name (type-only imports included, because they still pin the dependency); " +
  "'Effect.run*' counts calls named runPromise, runPromiseExit, runSync, runFork, or runCallback (PRD rule R1: the row's files are the named boundary modules); " +
  "'catch:effect-importer' counts, only in files with a runtime import specifier equal to effect or starting with effect/ or @effect/ (type-only imports and all-type specifier lists do not qualify), catch clauses plus .catch( calls, excluding the Effect.catch combinator. " +
  'Every row is a per-file allowlist of shrink-only counts: a count that rose, or a file absent from its row, fails. A count that shrank or a file that disappeared is stale headroom and also fails (unlike the dead-code ratchet, which only reports resolved findings), because a stale count is room a later PR could regrow into unnoticed; regenerate with `node scripts/check-effect-migration-ratchet.mjs --update` in the same PR. ' +
  'The PR that zeroes a row deletes the row. `@adapter-until YYYY-MM-DD` markers are a hard check in the same script, not a baseline.';

const compareCodePoints = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Production TypeScript files, repo-relative and '/'-joined, sorted. */
function productionFiles() {
  const packagesDir = join(rootDir, 'packages');
  const roots = [
    'src',
    ...readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/src`),
  ].filter((root) => existsSync(join(rootDir, root)));
  if (!roots.includes('src')) {
    throw new Error(`Production scope root missing: ${join(rootDir, 'src')}`);
  }
  const files = [];
  for (const root of roots) {
    for (const entry of walkFiles(join(rootDir, root), {
      include: (file) => /\.tsx?$/.test(file) && !/\.vitest\.ts$/.test(file),
      prune: (dir) => {
        const name = dir.slice(dir.lastIndexOf('/') + 1);
        return (
          name === 'node_modules' ||
          name === 'dist' ||
          (root === 'src' && dir === 'test-kernel')
        );
      },
    })) {
      files.push(`${root}/${entry.relativePath}`);
    }
  }
  return files.toSorted(compareCodePoints);
}

/** Specifier text of a string literal or substitution-free template. */
function staticSpecifierText(node) {
  return ts.isStringLiteral(node) ||
    node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    ? node.text
    : null;
}

/**
 * The module specifier a node contributes: import declarations (type-only
 * included), `export ... from`, `import x = require(...)`, and `require(...)`
 * / `import(...)` calls with a static argument. Null for every other node.
 */
function moduleSpecifier(node) {
  if (ts.isImportDeclaration(node)) {
    return staticSpecifierText(node.moduleSpecifier);
  }
  if (ts.isExportDeclaration(node)) {
    return node.moduleSpecifier == null
      ? null
      : staticSpecifierText(node.moduleSpecifier);
  }
  if (ts.isImportEqualsDeclaration(node)) {
    const reference = node.moduleReference;
    return ts.isExternalModuleReference(reference)
      ? staticSpecifierText(reference.expression)
      : null;
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const callee = node.expression;
    if (
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === 'require')
    ) {
      return staticSpecifierText(node.arguments[0]);
    }
  }
  return null;
}

/** Name a call is made under: the identifier or the member name. */
function calleeName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function importsEffect(specifier) {
  return (
    specifier === 'effect' ||
    specifier.startsWith('effect/') ||
    specifier.startsWith('@effect/')
  );
}

/**
 * Whether an import, `export ... from`, or import-equals declaration erases
 * at compile time: `import type`, `export type`, `import type X = require`,
 * or a specifier list whose every element is `type`-qualified.
 */
function isTypeOnly(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause == null) return false;
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return (
      clause.name == null &&
      bindings != null &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    );
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const clause = node.exportClause;
    return (
      clause != null &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly)
    );
  }
  return ts.isImportEqualsDeclaration(node) && node.isTypeOnly;
}

/**
 * Whether a specifier names the platform locator module: the `@platform`
 * alias, or a relative path that resolves to src/platform/platform.
 */
function isPlatformModule(specifier, fileName) {
  if (specifier === PLATFORM_MODULE) return true;
  if (!specifier.startsWith('.')) return false;
  const resolved = posix.normalize(
    posix.join(posix.dirname(fileName), specifier),
  );
  return resolved.replace(/\.(ts|js)$/, '') === PLATFORM_MODULE_PATH;
}

/**
 * Local names a file binds the platform locator to: `locals` are bindings of
 * the `platform` export itself (aliased or not); `namespaces` are namespace
 * imports whose `.platform` member is the locator. Import declarations are
 * top-level statements, so no tree walk is needed.
 */
function platformBindings(sourceFile, fileName) {
  const locals = new Set();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      const specifier = moduleSpecifier(statement);
      if (specifier != null && isPlatformModule(specifier, fileName)) {
        namespaces.add(statement.name.text);
      }
      continue;
    }
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = staticSpecifierText(statement.moduleSpecifier);
    const bindings = statement.importClause?.namedBindings;
    if (
      specifier == null ||
      bindings == null ||
      !isPlatformModule(specifier, fileName)
    ) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'platform') {
        locals.add(element.name.text);
      }
    }
  }
  return { locals, namespaces };
}

/**
 * Local names a file binds Effect's `Effect` module to, so `Effect.catch`
 * (the rc.112 combinator) is excluded from the catch row under any alias:
 * `locals` are bindings of the `Effect` export of 'effect' (aliased or not)
 * and namespace imports of 'effect/Effect'; `namespaces` are namespace
 * imports of 'effect', whose `.Effect.catch` is the combinator.
 */
function effectBindings(sourceFile) {
  const locals = new Set();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = staticSpecifierText(statement.moduleSpecifier);
    const bindings = statement.importClause?.namedBindings;
    if (specifier == null || bindings == null) continue;
    if (specifier === 'effect') {
      if (ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
        continue;
      }
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'Effect') {
          locals.add(element.name.text);
        }
      }
    } else if (
      specifier === 'effect/Effect' &&
      ts.isNamespaceImport(bindings)
    ) {
      locals.add(bindings.name.text);
    }
  }
  return { locals, namespaces };
}

/**
 * Per-row counts for one source text. Rows with a zero count are omitted so
 * the result is exactly the file's baseline contribution.
 */
function surveySource(text, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
  );
  const counts = new Map();
  const bump = (row) => counts.set(row, (counts.get(row) ?? 0) + 1);
  const { locals, namespaces } = platformBindings(sourceFile, fileName);
  const isPlatformRead = (callee) =>
    (ts.isIdentifier(callee) && locals.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text) &&
      callee.name.text === 'platform');
  const effect = effectBindings(sourceFile);
  const isEffectCombinator = (callee) =>
    ts.isPropertyAccessExpression(callee) &&
    ((ts.isIdentifier(callee.expression) &&
      effect.locals.has(callee.expression.text)) ||
      (ts.isPropertyAccessExpression(callee.expression) &&
        ts.isIdentifier(callee.expression.expression) &&
        effect.namespaces.has(callee.expression.expression.text) &&
        callee.expression.name.text === 'Effect'));
  let effectImporter = false;
  let catches = 0;

  const visit = (node) => {
    const specifier = moduleSpecifier(node);
    if (specifier != null) {
      if (SUPERSEDED_PACKAGES.includes(specifier)) bump(importRow(specifier));
      if (importsEffect(specifier) && !isTypeOnly(node)) effectImporter = true;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = calleeName(node);
      if (isPlatformRead(callee)) bump(ROW_PLATFORM);
      if (name === 'setServices') bump(ROW_SET_SERVICES);
      if (name != null && RUN_BOUNDARY_NAMES.has(name)) bump(ROW_RUN_BOUNDARY);
      if (
        name === 'catch' &&
        ts.isPropertyAccessExpression(callee) &&
        !isEffectCombinator(callee)
      ) {
        catches += 1;
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'AbortController'
    ) {
      bump(ROW_ABORT_CONTROLLER);
    } else if (ts.isCatchClause(node)) {
      catches += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (effectImporter && catches > 0) counts.set(ROW_CATCH, catches);
  return counts;
}

/** Fail the ratchet itself if the classifier regresses. */
function selfTestSurvey() {
  const cases = [
    {
      text: "import { platform, tryPlatform } from '@platform/platform';\n// platform() in prose\nconst s = 'platform()';\ntryPlatform();\nhost.platform();\n",
      expected: {},
    },
    {
      text: "import { platform } from '@platform/platform';\nplatform();\nconst fs = platform().fs;\n",
      expected: { [ROW_PLATFORM]: 2 },
    },
    {
      text: "import { platform as p } from '@platform/platform';\nimport * as P from '@platform/platform';\nimport { platform } from 'node:os';\np();\nP.platform();\nP.tryPlatform();\nplatform();\n",
      expected: { [ROW_PLATFORM]: 2 },
    },
    {
      text: "import { platform } from '../platform/platform';\nplatform();\n",
      expected: {},
    },
    {
      text: "import { platform } from './platform';\nplatform();\n",
      fileName: 'src/platform/probe.ts',
      expected: { [ROW_PLATFORM]: 1 },
    },
    {
      text: "import PQueue from 'p-queue';\nimport type { Options } from 'delay';\nimport pd from 'p-delay';\nimport local from './delay';\nconst map = require('p-map');\nexport { retry } from 'p-retry';\nawait import('neverthrow');\n",
      expected: {
        [importRow('p-queue')]: 1,
        [importRow('delay')]: 1,
        [importRow('p-map')]: 1,
        [importRow('p-retry')]: 1,
        [importRow('neverthrow')]: 1,
      },
    },
    {
      text: 'class S { get runPromise() { return this.p; } }\n// Effect.runSync(x)\n',
      expected: {},
    },
    {
      text: 'runtime.runFork(fiber);\nEffect.runSync(program);\nawait effectRuntime().runPromiseExit(program);\n',
      expected: { [ROW_RUN_BOUNDARY]: 3 },
    },
    {
      text: "import { Effect } from 'effect';\ntry { a(); } catch (error) { b(); }\ntry { c(); } catch { d(); }\nvoid p.catch(() => undefined);\nEffect.catch(program, handler);\n",
      expected: { [ROW_CATCH]: 3 },
    },
    {
      text: 'try { a(); } catch (error) { b(); }\nvoid p.catch(() => undefined);\n',
      expected: {},
    },
    {
      text: "import type { Stream } from 'effect';\nimport { type Effect } from 'effect';\nexport type { Exit } from 'effect';\ntry { a(); } catch { b(); }\n",
      expected: {},
    },
    {
      text: "import { Effect, type Stream } from 'effect';\ntry { a(); } catch { b(); }\n",
      expected: { [ROW_CATCH]: 1 },
    },
    {
      text: "import { Effect as Eff } from 'effect';\nimport * as E from 'effect';\nimport * as Fx from 'effect/Effect';\nEff.catch(a, h);\nE.Effect.catch(b, h);\nFx.catch(c, h);\nE.catch(d, h);\nEffect.catch(e, h);\nvoid p.catch(() => undefined);\n",
      expected: { [ROW_CATCH]: 3 },
    },
    {
      text: 'const c = new AbortController();\nflow.setServices(services);\nsetServices(services);\n',
      expected: { [ROW_ABORT_CONTROLLER]: 1, [ROW_SET_SERVICES]: 2 },
    },
  ];
  for (const { text, fileName = 'case.ts', expected } of cases) {
    const actual = Object.fromEntries(surveySource(text, fileName));
    if (
      JSON.stringify(sortObject(actual)) !==
      JSON.stringify(sortObject(expected))
    ) {
      console.error(
        'surveySource self-test failed:',
        JSON.stringify({ text, actual, expected }),
      );
      process.exit(1);
    }
  }
}

function sortObject(object) {
  return Object.fromEntries(
    Object.entries(object).toSorted(([a], [b]) => compareCodePoints(a, b)),
  );
}

/** Survey the tree: { rows: { rowId: { file: count } }, texts: { file: text } }. */
function surveyTree(files) {
  const rows = Object.fromEntries(ROWS.map((row) => [row.id, {}]));
  const texts = new Map();
  for (const file of files) {
    const text = readFileSync(join(rootDir, file), 'utf8');
    texts.set(file, text);
    for (const [row, count] of surveySource(text, file)) {
      rows[row][file] = count;
    }
  }
  return { rows, texts };
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** Local calendar date as YYYY-MM-DD — the one legitimate clock read here. */
function localToday() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * `@adapter-until YYYY-MM-DD` markers on temporary adapters. Any marker
 * dated before `today`, or with an unparsable date, fails.
 */
function checkAdapterMarkers(texts, today) {
  const failures = [];
  let total = 0;
  for (const [file, text] of texts) {
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(/@adapter-until\b\s*(\S*)/g)) {
        total += 1;
        const date = match[1];
        const where = `${file}:${index + 1}`;
        if (!isIsoDate(date)) {
          failures.push(
            `${where}: @adapter-until needs an ISO date (YYYY-MM-DD), got ${JSON.stringify(date)}`,
          );
        } else if (date < today) {
          failures.push(
            `${where}: @adapter-until ${date} has expired (today is ${today}); retire the adapter or re-justify the date in this PR`,
          );
        }
      }
    });
  }
  return { total, failures };
}

function readBaseline() {
  if (!existsSync(baselinePath)) {
    throw new Error(
      `Baseline missing: ${baselinePath}. Run \`node scripts/check-effect-migration-ratchet.mjs --update\` to create it.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    throw new Error(`Baseline unreadable: ${baselinePath}: ${error.message}`, {
      cause: error,
    });
  }
  const rows = parsed?.rows;
  const expectedIds = ROWS.map((row) => row.id);
  if (
    typeof parsed?.semantics !== 'string' ||
    rows == null ||
    typeof rows !== 'object' ||
    JSON.stringify(Object.keys(rows).toSorted(compareCodePoints)) !==
      JSON.stringify(expectedIds.toSorted(compareCodePoints))
  ) {
    throw new Error(
      `Baseline shape out of sync with the script rows (${expectedIds.join(', ')}): ${baselinePath}. Run --update.`,
    );
  }
  for (const [row, entries] of Object.entries(rows)) {
    for (const [file, count] of Object.entries(entries)) {
      if (!Number.isInteger(count) || count < 1) {
        throw new Error(
          `Baseline row ${row} has a non-positive count for ${file}: ${JSON.stringify(count)}. Run --update.`,
        );
      }
    }
  }
  return parsed;
}

function writeBaseline(rows) {
  const sortedRows = Object.fromEntries(
    ROWS.map((row) => [row.id, sortObject(rows[row.id])]),
  );
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ semantics: SEMANTICS, rows: sortedRows }, null, 2)}\n`,
  );
}

/** Compare a survey against the baseline: { failures, stale }. */
function diffRows(current, baseline) {
  const failures = [];
  const stale = [];
  for (const row of ROWS) {
    const now = current[row.id];
    const was = baseline[row.id];
    for (const [file, count] of Object.entries(now)) {
      if (!(file in was)) {
        failures.push({ row, file, was: 0, now: count, kind: 'new file' });
      } else if (count > was[file]) {
        failures.push({ row, file, was: was[file], now: count, kind: 'grew' });
      } else if (count < was[file]) {
        stale.push({ row, file, was: was[file], now: count });
      }
    }
    for (const [file, count] of Object.entries(was)) {
      if (!(file in now)) stale.push({ row, file, was: count, now: 0 });
    }
  }
  return { failures, stale };
}

function sites(entries) {
  return Object.values(entries).reduce((sum, count) => sum + count, 0);
}

function parseArgs(argv) {
  const options = { update: false, today: null };
  for (const arg of argv) {
    if (arg === '--update') {
      options.update = true;
    } else if (arg.startsWith('--today=')) {
      const value = arg.slice('--today='.length);
      if (!isIsoDate(value)) {
        throw new Error(
          `--today needs YYYY-MM-DD, got ${JSON.stringify(value)}`,
        );
      }
      options.today = value;
    } else {
      throw new Error(
        `Unknown argument ${JSON.stringify(arg)}; expected --update and/or --today=YYYY-MM-DD`,
      );
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  selfTestSurvey();
  const files = productionFiles();
  const { rows, texts } = surveyTree(files);
  const today = options.today ?? localToday();
  let failed = false;

  if (options.update) {
    writeBaseline(rows);
    console.log(`Effect migration baseline written: ${baselinePath}`);
  }

  const baseline = readBaseline();
  console.log(
    `Effect migration ratchet over ${files.length} production files (baseline: ${baselinePath}):`,
  );
  for (const row of ROWS) {
    const now = rows[row.id];
    const was = baseline.rows[row.id];
    console.log(
      `  ${row.id.padEnd(24)} ${Object.keys(now).length} files / ${sites(now)} sites` +
        ` (baseline ${Object.keys(was).length} files / ${sites(was)} sites)`,
    );
  }

  const { failures, stale } = diffRows(rows, baseline.rows);
  if (failures.length > 0) {
    failed = true;
    console.error(
      `\nEffect migration ratchet failed: ${failures.length} count(s) grew beyond the baseline.`,
    );
    for (const { row, file, was, now, kind } of failures) {
      console.error(`  - [${row.id}] ${file}: ${was} -> ${now} (${kind})`);
      console.error(`      ${row.rule}`);
    }
    console.error(
      '\nRemove the new use, or — only when the PR body justifies it — regenerate the baseline with ' +
        '`node scripts/check-effect-migration-ratchet.mjs --update` in the same PR.',
    );
  }
  if (stale.length > 0) {
    failed = true;
    console.error(
      `\nEffect migration ratchet failed: ${stale.length} baseline count(s) are stale headroom (the tree shrank below them).`,
    );
    for (const { row, file, was, now } of stale) {
      console.error(`  - [${row.id}] ${file}: ${was} -> ${now}`);
    }
    console.error(
      '\nGood news; lock it in: run `node scripts/check-effect-migration-ratchet.mjs --update` and commit the baseline in this PR.',
    );
  }

  const markers = checkAdapterMarkers(texts, today);
  if (markers.failures.length > 0) {
    failed = true;
    console.error(
      `\n@adapter-until check failed (today is ${today}): ${markers.failures.length} of ${markers.total} marker(s).`,
    );
    for (const failure of markers.failures) console.error(`  - ${failure}`);
  } else {
    console.log(
      `@adapter-until markers OK: ${markers.total} marker(s), none expired as of ${today}.`,
    );
  }

  if (failed) process.exit(1);
  console.log(
    'Effect migration ratchet OK: no count grew, no baseline headroom.',
  );
}

main();
