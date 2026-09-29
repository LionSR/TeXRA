#!/usr/bin/env node
// Effect migration ratchet — Phase 1 of
// .agents/docs/archived/architecture/2026-08-26-effect-4-runtime-migration.md, "Execution strategy"
// rule 3: leftovers fail CI, not review.
//
// Counts, per production file, the mechanisms the migration retires and
// freezes them in config/ratchets/effect-migration-baseline.json as counts
// that may only shrink: `new AbortController(` constructions and
// `Effect.run*` calls below R1's boundary kinds. Every row is a per-file
// allowlist: a file absent from a row fails on its first site. A category
// that reaches zero retires with its counting code (#12887); the one
// exception is the `Effect.run*` boundary check, which stays at zero as the
// standing gate that keeps runs at R1's boundary kinds. The `platform()`,
// ambient-carrier, superseded-package import and raw-catch rows retired this
// way once their last site was gone.
//
// The owner's second ruling of 2026-09-06 ("fully embrace Effect. No more
// pass-throughs nor adapters"; PRD R1 and execution rule 3 as amended) shapes
// the `Effect.run*` row: it counts only runs below R1's three boundary kinds
// (a host entry under packages/extension, packages/desktop, or packages/cli;
// the SDK's public API under packages/agent/src -- the tool `execute()`
// contract was the third kind until #12337 made every tool return an Effect),
// so it only ever shrinks, and `--update` never adds a file to any row, so
// new debt fails instead of being admitted (owner ruling 2026-09-06: never
// widen a ratchet in config/ratchets/). The ruling's other half, that no
// `@adapter-until` marker may exist, is ESLint's `no-warning-comments` in
// eslint.config.mjs.
//
// Files are parsed with the TypeScript compiler API (the repo's `typescript`
// devDependency) rather than grepped, so a comment or string literal that
// merely mentions `Effect.runSync(`, or a getter that happens to be named
// `runPromise`, classifies the way the compiler sees it.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
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
  'effect-migration-baseline.json',
);
const PRD =
  '.agents/docs/archived/architecture/2026-08-26-effect-4-runtime-migration.md';
/** This script, for the message that tells a reader where to retire a row. */
const SCRIPT_REL = 'scripts/check-effect-migration-ratchet.mjs';

const RUN_BOUNDARY_NAMES = new Set([
  'runPromise',
  'runPromiseExit',
  'runSync',
  'runFork',
  'runCallback',
]);

/**
 * R1's boundary kinds, as path predicates: (a) a host entry a host framework
 * invokes, (c) the SDK's public Promise API. Kind (b), the agent tool
 * `execute()` contract, was retired by #12337: tools return Effects and the
 * dispatcher owns the one run site, so a run inside `src/tools/**` is debt
 * like any other below-boundary run and counts here. `--update` admits a new
 * `Effect.run*` file only under (a) or (c); a run site anywhere else is below
 * the boundary and converts instead.
 */
const BOUNDARY_HOST_ROOTS = [
  'packages/extension/src/',
  'packages/desktop/src/',
  'packages/cli/src/',
  'packages/agent/src/',
];
/**
 * Webview frontends live under a host package but are not host entries: they
 * are VS Code-free zones (CLAUDE.md, "Separation of concerns"), so R1 does not
 * admit a run there. Without this the whole source root reads as a boundary
 * and their runs drop out of the row entirely -- which is how five tracked
 * sites in progressView/frontend/sessionTransport.ts once went silently
 * untracked. That file is now admitted deliberately, by name, in
 * BOUNDARY_RUNTIME_ENTRIES below; the directory exclusion still fences the rest.
 */
const BOUNDARY_HOST_EXCLUSIONS = [
  'packages/extension/src/progressView/frontend/',
  'packages/extension/src/settingsView/frontend/',
];

/**
 * Runtime entries outside the host roots, admitted by name and each with its
 * reason (owner ruling 2026-09-14). A webview owns its own `ManagedRuntime`, so
 * the module that installs and disposes that runtime is the webview's
 * composition root, and its runs are that root's, the way `extension.ts` runs
 * on the host runtime. The list is closed: every other file under the
 * exclusions above stays fenced, and adding a file here is a ruling, not a
 * refactor. Each entry declares its one approved runtime binding, and only a
 * run whose receiver is that binding is admitted (`localRuntimeRuns` in
 * surveySource). The binding must hold exactly, and every deviation fails
 * closed (no run in the file is approved):
 *  - exactly one approved declaration of the name; an import of the name, a
 *    second approved declaration, or any other declaration of it -- a plain
 *    shadow or a destructured one -- cancels the exemption;
 *  - for a factory entry: the variable's initializer is a call to the named
 *    factory as imported from `factoryModule` (not a same-named local or an
 *    import from anywhere else), and the runtime is disposed in the same
 *    file, because the entry's premise is that this module owns the
 *    runtime's whole lifecycle;
 *  - for a parameter entry: the parameter belongs to the `parameterOwner`
 *    function the ruling names, carries no default, and is typed exactly as
 *    the `parameterType` export of 'effect', because the premise is that the
 *    entry runs only on the runtime its caller passes. Deleting or renaming
 *    the owner does not transfer the exemption to another helper's lookalike
 *    parameter; re-admitting a new owner is a new ruling.
 * `Effect.runFork(...)`, a run on an imported value, or a run on any other
 * local stays on the row. An entry whose file no longer exists fails the
 * check (see main), so a dormant exemption cannot apply to unrelated code
 * created later at the same path.
 */
const BOUNDARY_RUNTIME_ENTRIES = new Map([
  [
    'packages/extension/src/progressView/frontend/sessionTransport.ts',
    {
      reason:
        "the progress webview's composition root: it installs the webview runtime (installWebviewRuntime) and disposes it, and every run in it is on that local",
      // The one approved binding: `const runtime = installWebviewRuntime()`,
      // the factory imported from its owning module, disposed in dispose().
      runtime: {
        name: 'runtime',
        initializer: 'installWebviewRuntime',
        factoryModule: {
          alias: '@controllers/session/webviewSessionLayer',
          path: 'src/controllers/session/webviewSessionLayer',
        },
      },
    },
  ],
  [
    'src/shared/signals.ts',
    {
      reason:
        'toSignal, the one meeting point between Effect and the components (PRD one-fold-three-renderers 7.5): it runs on the runtime its caller passes and reads no global',
      // The one approved binding: toSignal's `runtime: ManagedRuntime`
      // parameter -- pinned to that function by name, so the exemption
      // cannot transfer to another helper's lookalike parameter.
      runtime: {
        name: 'runtime',
        parameterType: 'ManagedRuntime',
        parameterOwner: 'toSignal',
      },
    },
  ],
  [
    'src/platform/processRuntime.ts',
    {
      reason:
        'the module that owns the process runtime type: withForkFailureReporting runs only on the runtime its caller passes — the parameter-entry premise',
      // The one approved binding: withForkFailureReporting's
      // `runtime: ManagedRuntime` parameter -- pinned to that function by
      // name, so the exemption cannot transfer to another helper's
      // lookalike parameter.
      runtime: {
        name: 'runtime',
        parameterType: 'ManagedRuntime',
        parameterOwner: 'withForkFailureReporting',
      },
    },
  ],
]);

const RUNTIME_ENTRY_PATHS = [...BOUNDARY_RUNTIME_ENTRIES.keys()];
const RUNTIME_ENTRY_NAMES = RUNTIME_ENTRY_PATHS.map((file) =>
  posix.basename(file),
);
const BOUNDARY_PATHS_TEXT = `packages/extension/src/**, packages/desktop/src/**, packages/cli/src/**, packages/agent/src/**, or a run on a local or parameter runtime in a named runtime entry (${RUNTIME_ENTRY_PATHS.join(', ')})`;

/** Whether a whole file sits at a host root (named runtime entries are
 *  classified per run instead: {@link belowBoundaryRuns}). */
function isBoundaryPath(file) {
  if (BOUNDARY_HOST_EXCLUSIONS.some((root) => file.startsWith(root))) {
    return false;
  }
  return BOUNDARY_HOST_ROOTS.some((root) => file.startsWith(root));
}

/**
 * The runs in a file that stay on the `Effect.run*` row: none at a host root;
 * at a named runtime entry, every run whose receiver is not a runtime the
 * file itself binds; everywhere else, all of them.
 */
function belowBoundaryRuns(file, runs, localRuntimeRuns) {
  if (BOUNDARY_RUNTIME_ENTRIES.has(file)) return runs - localRuntimeRuns;
  return isBoundaryPath(file) ? 0 : runs;
}

/**
 * Whether a binding pattern declares the name, at any nesting depth
 * (`const { runtime } = client`, `function f({ runtime })`). A destructured
 * declaration of the approved name is a shadow, not the approved binding.
 */
function patternDeclaresName(pattern, name) {
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;
    if (ts.isIdentifier(element.name)) {
      if (element.name.text === name) return true;
    } else if (patternDeclaresName(element.name, name)) {
      return true;
    }
  }
  return false;
}

/**
 * The outermost and innermost identifiers of a type reference's name:
 * `ManagedRuntime` reads as (ManagedRuntime, ManagedRuntime) and
 * `ManagedRuntime.ManagedRuntime` likewise. Null for a non-reference type.
 */
function typeReferenceEnds(type) {
  if (!ts.isTypeReferenceNode(type)) return null;
  let outer = type.typeName;
  while (ts.isQualifiedName(outer)) outer = outer.left;
  let inner = type.typeName;
  while (ts.isQualifiedName(inner)) inner = inner.right;
  return { outer: outer.text, inner: inner.text };
}

/**
 * Whether the file binds the named export of 'effect': a named import from
 * 'effect' (type-only elements included -- this is a type position), or a
 * default or namespace import of the 'effect/<name>' submodule.
 */
function bindsEffectExport(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = staticSpecifierText(statement.moduleSpecifier);
    const clause = statement.importClause;
    if (specifier == null || clause == null) continue;
    if (specifier === 'effect') {
      const bindings = clause.namedBindings;
      if (bindings != null && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === name) {
            return true;
          }
        }
      }
    } else if (
      specifier === `effect/${name}` &&
      (clause.name != null ||
        (clause.namedBindings != null &&
          ts.isNamespaceImport(clause.namedBindings)))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a parameter's type names the approved runtime type exactly: a
 * reference whose outer and inner identifiers are both `parameterType`
 * (`ManagedRuntime` or `ManagedRuntime.ManagedRuntime`), with that export of
 * 'effect' imported by the file. A name that merely contains it
 * (`FakeManagedRuntime`, `ManagedRuntimeAdapter`) or one no import binds is
 * not the approved type.
 */
function isApprovedRuntimeType(sourceFile, type, parameterType) {
  const ends = typeReferenceEnds(type);
  return (
    ends != null &&
    ends.outer === parameterType &&
    ends.inner === parameterType &&
    bindsEffectExport(sourceFile, parameterType)
  );
}

/**
 * The name of the function a parameter belongs to: the declared name of a
 * function or method, or the variable an arrow/function expression is
 * assigned to. Null when the owner has no stable name, which fails closed.
 */
function parameterOwnerName(parameter) {
  const fn = parameter.parent;
  if (
    (ts.isFunctionDeclaration(fn) ||
      ts.isFunctionExpression(fn) ||
      ts.isMethodDeclaration(fn)) &&
    fn.name != null &&
    ts.isIdentifier(fn.name)
  ) {
    return fn.name.text;
  }
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  ) {
    return fn.parent.name.text;
  }
  return null;
}

/**
 * Whether a named runtime entry binds its approved runtime name in exactly
 * the approved shape -- see the BOUNDARY_RUNTIME_ENTRIES docblock. Any
 * deviation fails closed: no run in the file is approved.
 */
function bindsApprovedRuntime(sourceFile, fileName, spec) {
  let approved = 0;
  let other = 0;
  // A factory-owned runtime must be disposed in the same file; a caller-owned
  // parameter is disposed by its caller, not here.
  let disposed = spec.initializer == null;
  const factoryLocals =
    spec.initializer == null
      ? null
      : importedLocals(
          sourceFile,
          fileName,
          spec.factoryModule.alias,
          spec.factoryModule.path,
          new Set([spec.initializer]),
        );
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      if (ts.isIdentifier(node.name)) {
        if (node.name.text === spec.name) {
          const byFactory =
            ts.isVariableDeclaration(node) &&
            spec.initializer != null &&
            node.initializer != null &&
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            node.initializer.expression.text === spec.initializer &&
            factoryLocals.has(node.initializer.expression.text);
          const byType =
            ts.isParameter(node) &&
            spec.parameterType != null &&
            parameterOwnerName(node) === spec.parameterOwner &&
            node.initializer == null &&
            node.type != null &&
            isApprovedRuntimeType(sourceFile, node.type, spec.parameterType);
          if (byFactory || byType) approved += 1;
          else other += 1;
        }
      } else if (patternDeclaresName(node.name, spec.name)) {
        other += 1;
      }
    }
    if (
      ((ts.isImportClause(node) && node.name) ||
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node)) &&
      node.name?.text === spec.name
    ) {
      other += 1;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === spec.name &&
      node.expression.name.text === 'dispose'
    ) {
      disposed = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return approved === 1 && other === 0 && disposed;
}

const BELOW_BOUNDARY = `below the boundary: R1's boundary kinds are ${BOUNDARY_PATHS_TEXT} (owner ruling 2026-09-06, ${PRD} R1). Convert this file and its callers so the run moves to one of them`;

const ROW_ABORT_CONTROLLER = 'new AbortController()';
const ROW_RUN_BOUNDARY = 'Effect.run*';

/**
 * Baseline rows in output order. Every row is a per-file allowlist of
 * shrink-only counts: a file absent from a row fails on its first site, and
 * a listed count may only stay or fall. `rule` is the PRD rule a failure
 * cites.
 */
const ROWS = [
  // The files it carries are adapters, and the counts are their allowlist — a
  // new file fails as new debt. claudeAgent.ts: the Claude Agent SDK's query()
  // options take a controller, not a signal, and Effect never hands out the
  // controller behind its own `({ signal })`; `Query.close()` takes the same
  // stdin-EOF shutdown but ends the drain quietly instead of rejecting with
  // the SDK's abort error, so a stopped turn would read as a finished one.
  // childRunLoop.ts: the one signal every
  // child-run turn runs under, handed straight to executeCommand's abort
  // waiter, the Codex SDK and the Claude Agent SDK; it is not fiber
  // interruption because a stopped turn still settles, delivers to its parent
  // (bash's `deliverAfterInterrupt`) and finalizes on the loop's fiber.
  {
    id: ROW_ABORT_CONTROLLER,
    rule: `${PRD} R5: interruption replaces internal abort choreography; an AbortController is adapted only where an external SDK or host API requires a signal`,
  },
  {
    id: ROW_RUN_BOUNDARY,
    rule: `${PRD} R1 (amended 2026-09-06): Effect inside, Promises only at the three boundary kinds — a host entry (packages/extension, packages/desktop, packages/cli, plus runs on a local or parameter runtime in the named runtime entries: ${RUNTIME_ENTRY_NAMES.join(', ')} — owner ruling 2026-09-14), or the SDK's public API (packages/agent/src); the tool execute() contract stopped being a boundary kind when #12337 made every tool return an Effect, so a run inside src/tools/** counts here. This row holds below-boundary runs only: a run AT a boundary is not debt and is not counted here at all, so a lane that moves runs to a host entry changes nothing in this row. The row therefore only ever shrinks`,
  },
];

const SEMANTICS =
  'Per-file counts of the mechanisms the Effect 4 migration retires (.agents/docs/archived/architecture/2026-08-26-effect-4-runtime-migration.md, execution rule 3), owned by scripts/check-effect-migration-ratchet.mjs. ' +
  'Scope: *.ts, *.tsx and *.mts under src/ and packages/*/src/, excluding src/test-kernel/, *.vitest.ts, and any dist/ or node_modules/ directory (packages/*/scripts and packages/*/tests are outside the scanned roots). ' +
  'Files are parsed with the TypeScript compiler API, so comments and string literals never count. ' +
  "Rows: 'new AbortController()' counts new-expressions on the identifier AbortController; " +
  `'Effect.run*' counts calls named runPromise, runPromiseExit, runSync, runFork, or runCallback, and counts them ONLY below R1's boundary kinds (packages/extension/src/**, packages/desktop/src/**, packages/cli/src/**, packages/agent/src/**, or a run on a runtime the file binds as a local or parameter inside a named runtime entry — ${RUNTIME_ENTRY_PATHS.join(', ')}; the tool execute() contract was a kind until #12337). A run at one of those kinds is the destination, not debt, and is absent from this row, so converting a subsystem cannot raise it. --update never adds a file to a row and writes the lower of the committed count and the tree's). ` +
  'Every row is a per-file allowlist of shrink-only counts: a count that rose, or a file absent from its row, fails. A count that shrank or a file that disappeared is stale headroom and also fails (unlike the dead-code ratchet, which only reports resolved findings), because a stale count is room a later PR could regrow into unnoticed; regenerate with `node scripts/check-effect-migration-ratchet.mjs --update` in the same PR. ' +
  "The PR that zeroes a row retires it: the baseline row, the script's ROWS entry, counting site and self-test case go together. 'Effect.run*' is the exception: it stays surveyed at zero, omitted from the baseline, so a later below-boundary run fails as a new file.";

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
      include: (file) =>
        /\.(?:tsx?|mts)$/.test(file) && !/\.vitest\.ts$/.test(file),
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

/** Name a call is made under: the identifier or the member name. */
function calleeName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/**
 * Whether a specifier names the module at `modulePath`: its path alias, or a
 * relative path that resolves to it. A named runtime entry's factory module
 * is matched this way.
 */
function isModuleAt(specifier, fileName, alias, modulePath) {
  if (specifier === alias) return true;
  if (!specifier.startsWith('.')) return false;
  const resolved = posix.normalize(
    posix.join(posix.dirname(fileName), specifier),
  );
  return resolved.replace(/\.(ts|js)$/, '') === modulePath;
}

/**
 * Local names a file binds the given named exports of one module to, aliased
 * or not. Import declarations are top-level statements, so no tree walk is
 * needed. Used for a named runtime entry's factory.
 */
function importedLocals(sourceFile, fileName, alias, modulePath, exports) {
  const locals = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = staticSpecifierText(statement.moduleSpecifier);
    const bindings = statement.importClause?.namedBindings;
    if (
      specifier == null ||
      bindings == null ||
      !ts.isNamedImports(bindings) ||
      !isModuleAt(specifier, fileName, alias, modulePath)
    ) {
      continue;
    }
    for (const element of bindings.elements) {
      if (exports.has((element.propertyName ?? element.name).text)) {
        locals.add(element.name.text);
      }
    }
  }
  return locals;
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
    // Parent pointers: bindsApprovedRuntime resolves the function a
    // parameter belongs to through node.parent.
    true,
  );
  const counts = new Map();
  const bump = (row) => counts.set(row, (counts.get(row) ?? 0) + 1);
  const entry = BOUNDARY_RUNTIME_ENTRIES.get(fileName);
  const approvedRuntime =
    entry != null && bindsApprovedRuntime(sourceFile, fileName, entry.runtime)
      ? entry.runtime.name
      : null;
  let localRuntimeRuns = 0;

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = calleeName(node);
      if (name != null && RUN_BOUNDARY_NAMES.has(name)) {
        bump(ROW_RUN_BOUNDARY);
        if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === approvedRuntime
        ) {
          localRuntimeRuns += 1;
        }
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'AbortController'
    ) {
      bump(ROW_ABORT_CONTROLLER);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { counts, localRuntimeRuns };
}

/** Fail the ratchet itself if the classifier regresses. */
function selfTestSurvey() {
  const cases = [
    {
      text: 'class S { get runPromise() { return this.p; } }\n// Effect.runSync(x)\n',
      expected: {},
    },
    {
      text: 'runtime.runFork(fiber);\nEffect.runSync(program);\nawait held.runPromiseExit(program);\n',
      expected: { [ROW_RUN_BOUNDARY]: 3 },
    },
    {
      text: 'const c = new AbortController();\n',
      expected: { [ROW_ABORT_CONTROLLER]: 1 },
    },
  ];
  for (const { text, fileName = 'case.ts', expected } of cases) {
    const actual = Object.fromEntries(surveySource(text, fileName).counts);
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

/** Survey the tree: { rows: { rowId: { file: count } } }. */
function surveyTree(files) {
  const rows = Object.fromEntries(ROWS.map((row) => [row.id, {}]));
  const localRuns = new Map();
  for (const file of files) {
    const text = readFileSync(join(rootDir, file), 'utf8');
    const { counts, localRuntimeRuns } = surveySource(text, file);
    if (localRuntimeRuns > 0) localRuns.set(file, localRuntimeRuns);
    for (const [row, count] of counts) {
      const entries = rows[row];
      // A row retired from ROWS whose counting site survives in surveySource
      // would otherwise crash here on an undefined index, from a stack trace
      // that names neither the row nor the leftover bump(). Skipping the
      // count instead would be worse: the mechanism would go untracked in
      // silence, which is the failure this whole script exists to prevent.
      if (entries == null) {
        throw new Error(
          `Row '${row}' is counted by surveySource but absent from ROWS (first seen in ${file}). Retiring a row means deleting its counting site too: remove the bump('${row}') call in surveySource and its self-test case, or restore the row to ROWS.`,
        );
      }
      entries[file] = count;
    }
  }
  // The `Effect.run*` row is the debt, and a run at one of R1's boundary kinds
  // is not debt -- it is the destination. Counting those too is what made
  // every conversion lane widen this baseline: runs MOVE to a host entry, so
  // the entry's count rises, and the ratchet then had to be argued with
  // rather than obeyed. Dropping them makes "this row only ever shrinks" true
  // by construction instead of by exception.
  rows[ROW_RUN_BOUNDARY] = Object.fromEntries(
    Object.entries(rows[ROW_RUN_BOUNDARY]).flatMap(([file, count]) => {
      const below = belowBoundaryRuns(file, count, localRuns.get(file) ?? 0);
      return below > 0 ? [[file, below]] : [];
    }),
  );
  return { rows };
}

/** Fail the ratchet itself if the boundary gate regresses. */
function selfTestBoundary() {
  // A named runtime entry admits only runs on a runtime it binds itself: an
  // `Effect.run*` or a run on an imported runtime in the same file stays on
  // the row, and a sibling in the same frontend keeps every run.
  const probe = surveySource(
    "import { Effect, type ManagedRuntime } from 'effect';\nimport { shared } from './runtime';\nexport function toSignal(runtime: ManagedRuntime.ManagedRuntime<never, never>) { return runtime.runFork(a); }\nfunction g(client) { return client.runPromise(b); }\nconst other = importedApi;\nother.runSync(c);\nEffect.runFork(d);\nshared.runPromise(e);\n",
    'src/shared/signals.ts',
  );
  const transportProbe = surveySource(
    "import { installWebviewRuntime } from '@controllers/session/webviewSessionLayer';\nconst runtime = installWebviewRuntime();\nruntime.runSync(a);\nconst runtime2 = makeRuntime();\nruntime2.runFork(b);\nvoid runtime.dispose();\n",
    'packages/extension/src/progressView/frontend/sessionTransport.ts',
  );
  const shadowProbe = surveySource(
    "import { installWebviewRuntime } from '@controllers/session/webviewSessionLayer';\nconst runtime = installWebviewRuntime();\nfunction h(runtime) { return runtime.runFork(x); }\nruntime.runSync(y);\nvoid runtime.dispose();\n",
    'packages/extension/src/progressView/frontend/sessionTransport.ts',
  );
  const destructuredProbe = surveySource(
    "import { installWebviewRuntime } from '@controllers/session/webviewSessionLayer';\nconst runtime = installWebviewRuntime();\nfunction f({ runtime }) { return runtime.runFork(x); }\nruntime.runSync(y);\nvoid runtime.dispose();\n",
    'packages/extension/src/progressView/frontend/sessionTransport.ts',
  );
  const undisposedProbe = surveySource(
    "import { installWebviewRuntime } from '@controllers/session/webviewSessionLayer';\nconst runtime = installWebviewRuntime();\nruntime.runSync(a);\n",
    'packages/extension/src/progressView/frontend/sessionTransport.ts',
  );
  const foreignFactoryProbe = surveySource(
    "import { installWebviewRuntime } from './localRuntime';\nconst runtime = installWebviewRuntime();\nruntime.runSync(a);\nvoid runtime.dispose();\n",
    'packages/extension/src/progressView/frontend/sessionTransport.ts',
  );
  const localFactoryProbe = surveySource(
    'function installWebviewRuntime() { return makeRuntime(); }\nconst runtime = installWebviewRuntime();\nruntime.runSync(a);\nvoid runtime.dispose();\n',
    'packages/extension/src/progressView/frontend/sessionTransport.ts',
  );
  const twoApprovedProbe = surveySource(
    "import { type ManagedRuntime } from 'effect';\nexport function toSignal(runtime: ManagedRuntime.ManagedRuntime<never, never>) { return runtime.runFork(a); }\nfunction toSignal(runtime: ManagedRuntime.ManagedRuntime<never, never>) { return runtime.runSync(b); }\n",
    'src/shared/signals.ts',
  );
  const wrongOwnerProbe = surveySource(
    "import { type ManagedRuntime } from 'effect';\nfunction helper(runtime: ManagedRuntime.ManagedRuntime<never, never>) { return runtime.runFork(a); }\n",
    'src/shared/signals.ts',
  );
  const wrongTypeProbe = surveySource(
    "import { type ManagedRuntime } from 'effect';\nexport function toSignal(runtime: FakeManagedRuntime<never, never>) { return runtime.runFork(a); }\n",
    'src/shared/signals.ts',
  );
  const unboundTypeProbe = surveySource(
    'export function toSignal(runtime: ManagedRuntime.ManagedRuntime<never, never>) { return runtime.runFork(a); }\n',
    'src/shared/signals.ts',
  );
  const defaultedProbe = surveySource(
    "import { type ManagedRuntime } from 'effect';\nimport { shared } from './runtime';\nexport function toSignal(runtime: ManagedRuntime.ManagedRuntime<never, never> = shared) { return runtime.runFork(a); }\n",
    'src/shared/signals.ts',
  );
  const siblingProbe = surveySource(
    'const runtime = installWebviewRuntime();\nruntime.runSync(a);\n',
    'packages/extension/src/progressView/frontend/ProgressApp.ts',
  );
  const processRuntimeProbe = surveySource(
    "import { Effect, type ManagedRuntime } from 'effect';\nexport function withForkFailureReporting(runtime: ManagedRuntime.ManagedRuntime<never, never>) {\n  const reportExit = (exit) => runtime.runFork(Effect.logError(exit));\n  return { ...runtime, runFork: (effect, options) => runtime.runFork(effect, options) };\n}\n",
    'src/platform/processRuntime.ts',
  );
  const siblingParameterProbe = surveySource(
    "import { type ManagedRuntime } from 'effect';\nexport function withForkFailureReporting(runtime: ManagedRuntime.ManagedRuntime<never, never>) { return runtime.runFork(a); }\nexport function makeReporting(runtime) { return runtime; }\n",
    'src/platform/processRuntime.ts',
  );
  const runCases = [
    [(probe.counts.get(ROW_RUN_BOUNDARY) ?? 0) === 5, 'probe run count'],
    [
      probe.localRuntimeRuns === 1,
      'only the typed runtime parameter is approved',
    ],
    [
      transportProbe.localRuntimeRuns === 1,
      'only the factory-initialized local is approved',
    ],
    [
      shadowProbe.localRuntimeRuns === 0,
      'a second declaration of the name fails closed',
    ],
    [
      destructuredProbe.localRuntimeRuns === 0,
      'a destructured shadow of the name fails closed',
    ],
    [
      undisposedProbe.localRuntimeRuns === 0,
      'an undisposed factory runtime fails closed',
    ],
    [
      foreignFactoryProbe.localRuntimeRuns === 0,
      'the factory imported from another module fails closed',
    ],
    [
      localFactoryProbe.localRuntimeRuns === 0,
      'a locally defined factory fails closed',
    ],
    [
      twoApprovedProbe.localRuntimeRuns === 0,
      'a second approved declaration fails closed',
    ],
    [
      wrongOwnerProbe.localRuntimeRuns === 0,
      'the approved parameter belongs to the named owner function',
    ],
    [
      wrongTypeProbe.localRuntimeRuns === 0,
      'a type merely containing the type name fails closed',
    ],
    [
      unboundTypeProbe.localRuntimeRuns === 0,
      'the type name without the effect import fails closed',
    ],
    [
      defaultedProbe.localRuntimeRuns === 0,
      'a defaulted caller-owned parameter fails closed',
    ],
    [
      siblingProbe.localRuntimeRuns === 0,
      'a file outside the map has no approved runtime',
    ],
    [
      (processRuntimeProbe.counts.get(ROW_RUN_BOUNDARY) ?? 0) === 2 &&
        processRuntimeProbe.localRuntimeRuns === 2,
      "processRuntime's wrapper admits both runs on its caller-passed parameter",
    ],
    [
      siblingParameterProbe.localRuntimeRuns === 0,
      'a same-named parameter on another function in the entry fails closed',
    ],
    [
      belowBoundaryRuns('src/shared/signals.ts', 5, 1) === 4,
      'entry keeps unapproved runs',
    ],
    [
      belowBoundaryRuns('src/platform/processRuntime.ts', 2, 2) === 0,
      'processRuntime entry admits approved runs',
    ],
    [
      belowBoundaryRuns(
        'packages/extension/src/progressView/frontend/sessionTransport.ts',
        4,
        4,
      ) === 0,
      'entry admits approved runs',
    ],
    [
      belowBoundaryRuns(
        'packages/extension/src/progressView/frontend/ProgressApp.ts',
        3,
        3,
      ) === 3,
      'sibling ProgressApp stays fenced',
    ],
    [
      belowBoundaryRuns('src/shared/session/sessionFold.ts', 2, 2) === 2,
      'sibling sessionFold stays fenced',
    ],
    [
      belowBoundaryRuns('packages/cli/src/chat/tui/App.tsx', 2, 0) === 0,
      'host root admits all runs',
    ],
    [
      belowBoundaryRuns('src/controllers/session/SessionBridge.ts', 2, 2) === 2,
      'below boundary keeps local runs',
    ],
  ];
  for (const [ok, label] of runCases) {
    if (!ok) {
      console.error(`belowBoundaryRuns self-test failed: ${label}`);
      process.exit(1);
    }
  }

  const boundaryCases = [
    ['packages/extension/src/commands/run.ts', true],
    ['packages/desktop/src/main/ipc.ts', true],
    ['packages/cli/src/chat/tui/App.tsx', true],
    ['packages/agent/src/index.ts', true],
    // Kind (b) retired by #12337: a run inside src/tools/** is below the
    // boundary whatever the file is called and whatever class it declares.
    ['src/tools/EditTool.ts', false],
    ['src/tools/arxiv/SearchTool.ts', false],
    ['src/tools/claudeAgent.ts', false],
    ['src/tools/goal/goalRows.ts', false],
    ['src/tools/bash.ts', false],
    ['src/controllers/session/sessionLayer.ts', false],
    ['src/agent/runtime/SessionHandle.ts', false],
    ['src/controllers/session/SessionBridge.ts', false],
    ['packages/trace-viewer/src/main.ts', false],
    // A webview frontend sits under a host package but is a VS Code-free
    // zone, not a host entry, so R1 does not admit a run there.
    // A named runtime entry is not a whole-file boundary: its runs are
    // classified per receiver (belowBoundaryRuns, pinned below).
    ['packages/extension/src/progressView/frontend/sessionTransport.ts', false],
    ['packages/extension/src/progressView/frontend/ProgressApp.ts', false],
    ['src/shared/signals.ts', false],
    ['src/platform/processRuntime.ts', false],
    ['src/shared/session/sessionFold.ts', false],
    ['packages/extension/src/settingsView/frontend/settings.ts', false],
    // The extension-host frontend (no view-name segment) is host code and
    // stays a boundary — the two are easy to confuse, so both are pinned.
    ['packages/extension/src/frontend/auth/subscriptionSignIn.ts', true],
  ];
  for (const [file, expected] of boundaryCases) {
    if (isBoundaryPath(file) !== expected) {
      console.error(
        `isBoundaryPath self-test failed: ${file} expected ${expected}`,
      );
      process.exit(1);
    }
  }
}

const BASELINE_MISSING = `Baseline missing: ${baselinePath}. Restore it from git.`;

function readBaseline() {
  if (!existsSync(baselinePath)) throw new Error(BASELINE_MISSING);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    throw new Error(`Baseline unreadable: ${baselinePath}: ${error.message}`, {
      cause: error,
    });
  }
  const rows = parsed?.rows;
  const expectedIds = new Set(ROWS.map((row) => row.id));
  const baselineIds =
    rows != null && typeof rows === 'object' ? Object.keys(rows) : [];
  const extraIds = baselineIds.filter((id) => !expectedIds.has(id));
  if (
    typeof parsed?.semantics !== 'string' ||
    rows == null ||
    typeof rows !== 'object' ||
    extraIds.length > 0
  ) {
    throw new Error(
      `Baseline shape out of sync with the script rows (${[...expectedIds].join(', ')}): ${baselinePath}. Run --update.`,
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
  if (parsed.semantics !== SEMANTICS) {
    throw new Error(
      `Baseline semantics text is out of date with the script: ${baselinePath}. Run --update.`,
    );
  }
  return parsed;
}

/**
 * The committed counts, read for `--update`'s own gates.
 *
 * Deliberately looser than {@link readBaseline}: that one rejects a baseline
 * whose `semantics` text or row set has drifted from the script and tells the
 * reader to run `--update` — which would then call it and hit the same
 * rejection, so a legitimate script edit could never be recorded. The gates
 * need only the previous per-file counts. A row the baseline does not carry
 * is at zero, and `--update` keeps it there: that is how the `Effect.run*`
 * row stays a standing gate while omitted from the baseline.
 */
function readCommittedCounts() {
  if (!existsSync(baselinePath)) throw new Error(BASELINE_MISSING);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    throw new Error(`Baseline unreadable: ${baselinePath}: ${error.message}`, {
      cause: error,
    });
  }
  const committed = parsed?.rows ?? {};
  const has = (row) =>
    typeof committed[row] === 'object' && committed[row] !== null;
  return Object.fromEntries(
    ROWS.map((row) => [row.id, has(row.id) ? committed[row.id] : {}]),
  );
}

function writeBaseline(rows) {
  const sortedRows = Object.fromEntries(
    ROWS.flatMap((row) => {
      const entries = sortObject(rows[row.id]);
      return Object.keys(entries).length === 0 ? [] : [[row.id, entries]];
    }),
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
    const was = baseline[row.id] ?? {};
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

function main() {
  const { values: options } = parseArgs({
    options: { update: { type: 'boolean', default: false } },
  });
  selfTestSurvey();
  selfTestBoundary();
  const files = productionFiles();
  const fileSet = new Set(files);
  const staleEntries = RUNTIME_ENTRY_PATHS.filter((file) => !fileSet.has(file));
  if (staleEntries.length > 0) {
    console.error(
      `Effect migration ratchet failed: named runtime entries no longer exist: ${staleEntries.join(', ')}. Remove each from BOUNDARY_RUNTIME_ENTRIES in ${SCRIPT_REL} in the change that moved or deleted it; admitting the moved file again is a new ruling, not a rename.`,
    );
    process.exit(1);
  }
  const { rows } = surveyTree(files);
  let failed = false;

  if (options.update) {
    // Both gates run against the COMMITTED baseline and before anything is
    // written. Writing first and comparing after is how `--update` came to
    // accept both kinds of widening: the comparison below `--update` reads
    // back the file it had already replaced, so every count matched itself.
    const committed = readCommittedCounts();

    // `--update` records progress and nothing else: every count it writes is
    // the lower of the committed one and the tree's, so a ceiling can only
    // ever fall. Growth is still reported, and still fails, but it no longer
    // blocks the write -- refusing outright meant a tree with one new site
    // could not record any of its genuine shrinkage, which is how a
    // legitimate reduction ended up needing a hand edit.
    const { failures: grew } = diffRows(rows, committed);
    if (grew.length > 0) {
      console.error(
        `\n${grew.length} count(s) grew; the baseline keeps the committed ceiling for each and the check stays red until they are gone.`,
      );
      for (const { row, file, was, now, kind } of grew) {
        console.error(`  - [${row.id}] ${file}: ${was} -> ${now} (${kind})`);
      }
    }

    // Every written count is the lower of the committed one and the tree's,
    // and a file the row does not already carry is not added at all, so this
    // command cannot raise a ceiling or open a new one. A file that is new to
    // a row is new debt: the check reports it and stays red until it is gone,
    // which is the only outcome that does not quietly bless it.
    const tightened = Object.fromEntries(
      ROWS.map((row) => [
        row.id,
        Object.fromEntries(
          Object.entries(rows[row.id])
            .filter(([file]) => committed[row.id][file] != null)
            .map(([file, count]) => [
              file,
              Math.min(committed[row.id][file], count),
            ]),
        ),
      ]),
    );
    writeBaseline(tightened);
    console.log(`Effect migration baseline written: ${baselinePath}`);
  }

  const baseline = readBaseline();
  console.log(
    `Effect migration ratchet over ${files.length} production files (baseline: ${baselinePath}):`,
  );
  for (const row of ROWS) {
    const now = rows[row.id];
    const was = baseline.rows[row.id] ?? {};
    console.log(
      `  ${row.id.padEnd(24)} ${Object.keys(now).length} files / ${sites(now)} sites` +
        ` (baseline ${Object.keys(was).length} files / ${sites(was)} sites)`,
    );
  }

  // "The PR that zeroes a row deletes the row" is the baseline's own stated
  // semantics, and nothing enforced it: once a row's last file is gone,
  // `--update` writes the row empty and every later run is green, so the row,
  // its rule text and its counting site sit in the script forever describing
  // a mechanism the tree no longer has. `import:neverthrow` sat that way.
  // The gate keys on the BASELINE row being empty, not on the tree count: a
  // tree that has fallen below a non-empty baseline is stale headroom, which
  // the stale report below already names loudly and correctly.
  const emptyRows = ROWS.filter(
    (row) =>
      Object.hasOwn(baseline.rows, row.id) &&
      Object.keys(baseline.rows[row.id]).length === 0,
  );
  if (emptyRows.length > 0) {
    failed = true;
    console.error(
      `\nEffect migration ratchet failed: ${emptyRows.length} baseline row(s) are empty. The PR that zeroes a row deletes the row: an empty row is not a finished ratchet, it is a row nobody removed.`,
    );
    for (const row of emptyRows) {
      console.error(
        row.id === ROW_RUN_BOUNDARY
          ? `  - [${row.id}] Delete its empty object from the baseline; the row stays surveyed in ${SCRIPT_REL} as the standing boundary gate.`
          : `  - [${row.id}] Delete its empty object from the baseline, and its row-id constant, ROWS entry, bump('${row.id}') site and selfTestSurvey case from ${SCRIPT_REL}.`,
      );
    }
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
      if (row.id === ROW_RUN_BOUNDARY && !isBoundaryPath(file)) {
        console.error(`      This file is ${BELOW_BOUNDARY}.`);
      }
    }
    console.error(
      '\nRemove the new use. `node scripts/check-effect-migration-ratchet.mjs --update` records shrinkage ' +
        'but never a rise: it keeps the committed ceiling for a count that grew, and will not add a file a row ' +
        `does not already carry, so a new Effect.run* below ${BOUNDARY_PATHS_TEXT} cannot be admitted by regenerating — ` +
        'convert the file and its callers so the run moves to one of those kinds.',
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

  if (failed) process.exit(1);
  console.log(
    'Effect migration ratchet OK: no count grew, no baseline headroom.',
  );
}

main();
