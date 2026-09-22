#!/usr/bin/env node
// Effect-native test bodies — AGENTS.md, "Effect-native tests": a test body
// that executes an Effect program uses `it.effect` with `Effect.gen` +
// `yield*`, never `await Effect.runPromise(...)`. `Effect.runPromise` stays
// legitimate in hooks (`beforeEach` and friends) and in non-test helpers, so
// this gate counts only the sites whose innermost enclosing boundary is a
// test callback: `it(...)`, `test(...)`, `it.effect(...)`, `it.each(...)`
// and their modifier chains.
//
// The residual is a per-file allowlist of exact counts, each row carrying the
// reason the site stays — a Promise-only subject, a foreign Promise API the
// body awaits, a fate the 1.0 retirement boundary decides. Counts are
// shrink-only: a count that rose, or a site in a file absent from the
// exemptions, fails; a count that fell is stale headroom and fails too,
// because a stale count is room a later PR can regrow into unnoticed. The
// file that reaches zero deletes its entry; `--update` lowers counts and
// drops zeroed files but never adds one, and it fails rather than guesses
// when a file has no recorded reason.
//
// The counterpart on the production surface is scripts/check-effect-migration-ratchet.mjs
// (row `Effect.run*`), whose scan roots deliberately exclude src/test-kernel.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import ts from 'typescript';

import { walkFiles } from './walkFiles.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(
  rootDir,
  'config',
  'ratchets',
  'effect-test-run-baseline.json',
);
const TEST_ROOT = 'src/test-kernel';
const GUIDANCE =
  'AGENTS.md, "Effect-native tests": use it.effect with Effect.gen + yield*, or it.live when the body depends on real time';

/**
 * The runs this gate counts, as declared in the pinned Effect version. Every
 * way a test body can execute a program is here, `runSync` included: the suite
 * is converted, so a body that needs a run result `yield*`s it, and only hooks
 * and non-test helpers keep a run.
 */
const RUN_NAMES = new Set([
  'runPromise',
  'runPromiseExit',
  'runSync',
  'runFork',
  'runCallback',
]);

/** `it`, `test`, or a modifier chain on either (`it.effect`, `test.skipEach`). */
const TEST_CALLEE = /^(it|test)(\.[A-Za-z]+)*$/;
/**
 * The allowed surfaces that are not the test's own body: the four hooks plus
 * vitest's per-test teardown callbacks.
 */
const HOOK_CALLEE = /^(before|after)(Each|All)$|^onTest(Finished|Failed)$/;
/**
 * A callback handed to a mock factory or a poller is the double's code, not the
 * test's program: it cannot `yield*` (a `vi.fn` implementation and a
 * `vi.waitFor` poll are plain async callbacks) and runs only when the double
 * fires. Its runs are helper runs, the same allowance a named helper gets.
 */
const DOUBLE_CALLEE =
  /^(?:vi\.)?(?:fn|spyOn|stubGlobal|waitFor|waitForOptions)$|^(?:mock|spy)[A-Z]\w*$|\.(?:mock|spyOn)[A-Z]\w*$/;

function staticSpecifierText(node) {
  return ts.isStringLiteral(node) ? node.text : null;
}

/**
 * The boundary enclosing a call at `node`, found by walking out to the
 * function-like node that contains it and reading the call it is an argument
 * of: the innermost enclosing test wins, so an Effect run inside a nested
 * helper that a test body calls directly is still a test-body run only when
 * the helper itself is inline in the body. A run inside a named helper is not
 * counted, which is the documented allowance.
 */
/**
 * The name a call is made under, following a curried factory to its inner
 * callee: `it.each(cases)('name', body)` is a call of `it.each`, and reading
 * only the outer expression's text would see `it.each(cases)` and miss the
 * boundary. The prevailing style in this repository is curried, so without
 * this the gate would silently skip those bodies.
 */
function calleeText(call) {
  let expression = call.expression;
  while (ts.isCallExpression(expression)) expression = expression.expression;
  return expression.getText();
}

function enclosingBoundary(node) {
  let current = node;
  while (current != null) {
    const parent = current.parent;
    if (parent == null) return { kind: 'module' };
    if (
      (ts.isArrowFunction(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
      parent.name == null
    ) {
      const call = parent.parent;
      if (
        call != null &&
        ts.isCallExpression(call) &&
        call.arguments.includes(parent)
      ) {
        const callee = calleeText(call);
        if (TEST_CALLEE.test(callee)) return { kind: 'test', callee };
        if (HOOK_CALLEE.test(callee)) return { kind: 'hook', callee };
        if (
          /^describe(\.|$)/.test(callee) ||
          /^(it|test)\.(describe|suite)$/.test(callee)
        ) {
          return { kind: 'describe', callee };
        }
        if (DOUBLE_CALLEE.test(callee)) return { kind: 'double', callee };
        // Any other wrapper call: keep walking, its own body may be a test.
        current = call;
        continue;
      }
      // A bare function body with no enclosing call: a helper unless its own
      // parent chain reaches a test, which the loop above already handled.
      return { kind: 'helper' };
    }
    if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) {
      return { kind: 'helper' };
    }
    current = parent;
  }
  return { kind: 'module' };
}

/**
 * The names the file's own declarations bind inside the run vocabulary. A bare
 * `runSync(...)` whose name the file declares itself is the file's helper --
 * `src/test-kernel/scripts/SyncRemoteAgents.vitest.ts` drives a build script
 * with a local `runSync(root, argv)` -- not a run of an Effect, and counting it
 * would demand a conversion the guidance does not ask for.
 */
function locallyDeclaredRunNames(sourceFile) {
  const declared = new Set();
  const record = (name) => {
    if (name != null && RUN_NAMES.has(name.text)) declared.add(name.text);
  };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node)) record(node.name);
    else if (ts.isClassDeclaration(node)) record(node.name);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      record(node.name);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name))
      record(node.name);
    else if (ts.isImportDeclaration(node)) {
      // Importing the run itself from effect (`import { runPromise } from
      // 'effect/Effect'`) is the real thing, not a shadow: only a binding from
      // anywhere else hides it.
      const specifier = node.moduleSpecifier;
      const from = ts.isStringLiteral(specifier) ? specifier.text : '';
      if (
        from === 'effect' ||
        from.startsWith('effect/') ||
        from.startsWith('@effect/')
      ) {
        ts.forEachChild(node, visit);
        return;
      }
      const clause = node.importClause;
      if (clause == null) return;
      if (clause.name != null) declared.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings != null && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements)
          declared.add(element.name.text);
      } else if (bindings != null && ts.isNamespaceImport(bindings)) {
        declared.add(bindings.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declared;
}

/** The test-body run sites in one file: [{ line, callee }], 1-based lines. */
function testBodyRuns(sourceFile) {
  const sites = [];
  const shadowed = locallyDeclaredRunNames(sourceFile);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // A property access is a run on a runtime the file holds (`Effect`,
      // `runtime`, `testRuntime()`, a bundled copy); a bare identifier counts
      // only when the file does not declare that name itself.
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee) && !shadowed.has(callee.text)
          ? callee.text
          : null;
      if (name != null && RUN_NAMES.has(name)) {
        if (enclosingBoundary(node).kind === 'test') {
          sites.push({
            line:
              sourceFile.getLineAndCharacterOfPosition(node.getStart()).line +
              1,
            callee: node.expression.getText(),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** Every *.vitest.ts under the test root, as repo-relative posix paths. */
function testFiles() {
  return walkFiles(resolve(rootDir, TEST_ROOT), {
    include: (file) => file.endsWith('.vitest.ts'),
  })
    .map(({ absolutePath }) =>
      relative(rootDir, absolutePath).split('\\').join('/'),
    )
    .sort();
}

function readBaseline() {
  const raw = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const exemptions = raw.exemptions ?? {};
  for (const [file, entry] of Object.entries(exemptions)) {
    if (typeof entry?.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`${baselinePath}: ${file} has no recorded reason`);
    }
    if (!Number.isInteger(entry?.count) || entry.count < 1) {
      throw new Error(
        `${baselinePath}: ${file} needs a positive integer count`,
      );
    }
  }
  return raw;
}

/**
 * Current test-body run counts for every file that has at least one. Files
 * are parsed with `setParentNodes`, because the boundary of a run is read
 * from the node's ancestors; the program's own source files carry no parents.
 */
function survey() {
  const counts = new Map();
  for (const file of testFiles()) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(resolve(rootDir, file), 'utf8'),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const sites = testBodyRuns(sourceFile);
    if (sites.length > 0) counts.set(file, sites);
  }
  return counts;
}

const main = () => {
  const { values } = parseArgs({
    options: { update: { type: 'boolean', default: false } },
  });
  if (!existsSync(resolve(rootDir, TEST_ROOT))) {
    throw new Error(
      `the test root ${TEST_ROOT} is missing — this gate cannot scan`,
    );
  }
  const baseline = readBaseline();
  const exemptions = baseline.exemptions ?? {};
  const counts = survey();

  if (values.update) {
    const next = {};
    const dropped = [];
    for (const [file, entry] of Object.entries(exemptions)) {
      const sites = counts.get(file) ?? [];
      if (sites.length === 0) {
        dropped.push(file);
        continue;
      }
      if (sites.length > entry.count) {
        throw new Error(
          `${file} now has ${sites.length} test-body runs, above its allowlisted ${entry.count} (${entry.reason}); --update never widens an exemption`,
        );
      }
      if (sites.length < entry.count) {
        console.log(`${file}: ${entry.count} -> ${sites.length}`);
      }
      next[file] = { count: sites.length, reason: entry.reason };
    }
    const unlisted = [...counts.keys()].filter((file) => !(file in next));
    if (unlisted.length > 0) {
      throw new Error(
        `--update never adds a file to this list; these have test-body Effect.run* sites and need a conversion (${GUIDANCE}):\n  ${unlisted.join('\n  ')}`,
      );
    }
    for (const file of dropped)
      console.log(`${file}: exemption dropped (no sites left)`);
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ ...baseline, exemptions: next }, null, 2)}\n`,
    );
    console.log(`${baselinePath} regenerated`);
    return;
  }

  const findings = [];
  for (const [file, sites] of counts) {
    const entry = exemptions[file];
    if (entry == null) {
      findings.push({
        file,
        sites,
        message: `not in the allowlist (${GUIDANCE})`,
      });
      continue;
    }
    if (sites.length > entry.count) {
      findings.push({
        file,
        sites,
        message: `${sites.length} test-body runs above the allowlisted ${entry.count} — recorded reason: ${entry.reason}`,
      });
    } else if (sites.length < entry.count) {
      findings.push({
        file,
        sites: [],
        message: `allowlisted ${entry.count}, found ${sites.length}: stale headroom — run \`node scripts/check-effect-test-runs.mjs --update\` in the same change`,
      });
    }
  }
  for (const [file, entry] of Object.entries(exemptions)) {
    if (!counts.has(file) && existsSync(resolve(rootDir, file))) {
      findings.push({
        file,
        sites: [],
        message: `allowlisted ${entry.count}, found 0: stale headroom — delete the entry`,
      });
    }
    if (!existsSync(resolve(rootDir, file))) {
      findings.push({
        file,
        sites: [],
        message: 'allowlisted file no longer exists',
      });
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}: ${finding.message}`);
      for (const site of finding.sites)
        console.error(`  ${site.line}: ${site.callee}`);
    }
    console.error(
      `\n${findings.length} file(s) fail the Effect-native test-body gate (${GUIDANCE}).`,
    );
    process.exitCode = 1;
    return;
  }
  const exempt = Object.keys(exemptions).length;
  console.log(
    `check-effect-test-runs: no new test-body Effect.run* site (${exempt} reasoned exemption${exempt === 1 ? '' : 's'})`,
  );
};

main();
