#!/usr/bin/env node
// Effect migration ratchet — Phase 1 of
// .agents/docs/proposed/architecture/2026-08-26-effect-4-runtime-migration.md, "Execution strategy"
// rule 3: leftovers fail CI, not review.
//
// Counts, per production file, the mechanisms the migration retires and
// freezes them in config/ratchets/effect-migration-baseline.json as counts
// that may only shrink: `platform()` reads, `setServices()` calls,
// `new AbortController(` constructions, imports of the superseded
// concurrency/error packages, `Effect.run*` boundary calls (rule R1), and
// raw catch clauses in files that already import `effect` at runtime (rule
// R7). Every row is a per-file allowlist: a file absent from a row fails on
// its first site. The PR that zeroes a row deletes the row.
//
// Two checks carry the owner's second ruling of 2026-09-06 ("fully embrace
// Effect. No more pass-throughs nor adapters"; PRD R1 and execution rule 3
// as amended): there are no temporary adapters, so a separate hard check
// fails on the presence of any `@adapter-until` marker in production scope,
// not on its expiry; and the `Effect.run*` row separates runs at R1's three
// boundary kinds (a host entry under packages/extension, packages/desktop,
// or packages/cli; a tool `execute()` contract, until lane D; the SDK's
// public API under packages/agent/src) from runs below them. A run below the
// register is CLOSED: `--update` refuses a below-boundary file the committed
// `debtLanes` does not already name, and refuses any count that would grow
// (except `Effect.run*` at a boundary path, where a rise means runs moved up
// out of the debt below). The map records the debt that existed when it was
// written, names the lane deleting each file, and only ever shrinks — an
// entry whose debt is gone is rejected as stale. Naming future work does not
// admit new debt (owner ruling 2026-09-06: never widen a ratchet in
// config/ratchets/). Neither
// check can recognize an adapter written without a marker, since "adapter"
// is not mechanically recognizable; that stays a review obligation.
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
const PRD =
  '.agents/docs/proposed/architecture/2026-08-26-effect-4-runtime-migration.md';

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

/**
 * R1's three boundary kinds, as path predicates: (a) a host entry a host
 * framework invokes, (b) the agent tool `execute()` contract until lane D
 * converts the tool runner, (c) the SDK's public Promise API. `--update`
 * admits a new `Effect.run*` file only under one of these; a run site
 * anywhere else is below the boundary and converts instead.
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
 * sites in progressView/frontend/sessionTransport.ts went silently untracked.
 */
const BOUNDARY_HOST_EXCLUSIONS = [
  'packages/extension/src/webview/frontend/',
  'packages/extension/src/progressView/frontend/',
  'packages/extension/src/settingsView/frontend/',
];

const BOUNDARY_TOOL_ROOT = 'src/tools/';
const BOUNDARY_TOOL_SUFFIX = 'Tool.ts';
const BOUNDARY_PATHS_TEXT =
  'packages/extension/src/**, packages/desktop/src/**, packages/cli/src/**, packages/agent/src/**, or src/tools/**/*Tool.ts';

function isBoundaryPath(file, toolExecuteFiles) {
  if (BOUNDARY_HOST_EXCLUSIONS.some((root) => file.startsWith(root))) {
    return false;
  }
  return (
    BOUNDARY_HOST_ROOTS.some((root) => file.startsWith(root)) ||
    (file.startsWith(BOUNDARY_TOOL_ROOT) &&
      (file.endsWith(BOUNDARY_TOOL_SUFFIX) ||
        (toolExecuteFiles?.has(file) ?? false)))
  );
}

const BELOW_BOUNDARY = `below the boundary: R1's boundary kinds are ${BOUNDARY_PATHS_TEXT} (owner ruling 2026-09-06, ${PRD} R1). Convert this file and its callers so the run moves to one of them. The debtLanes register is closed: it names the debt that already existed and shrinks as lanes land, and --update will not admit a file it does not already name`;

/** Module specifiers that export the tool contract factory. */
const TOOL_DEFINE_MODULES = new Set([
  '@tools/core/define',
  './core/define',
  '../core/define',
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
    rule: `${PRD} R1 (amended 2026-09-06): Effect inside, Promises only at the three boundary kinds — a host entry (packages/extension, packages/desktop, packages/cli), the tool execute() contract (src/tools/**/*Tool.ts, until lane D), or the SDK's public API (packages/agent/src). This row holds below-boundary runs only: a run AT a boundary is not debt and is not counted here at all, so a lane that moves runs to a host entry changes nothing in this row. The row therefore only ever shrinks`,
  },
  {
    id: ROW_CATCH,
    rule: `${PRD} R7 and execution rule 2 (one pass per file): a file that imports 'effect' converts its catch sites in the same pass — typed recovery, scope finalizers, or Exit folds; a raw catch remains only inside a named foreign-runtime adapter`,
  },
];

const SEMANTICS =
  'Per-file counts of the mechanisms the Effect 4 migration retires (.agents/docs/proposed/architecture/2026-08-26-effect-4-runtime-migration.md, execution rule 3), owned by scripts/check-effect-migration-ratchet.mjs. ' +
  'Scope: *.ts and *.tsx under src/ and packages/*/src/, excluding src/test-kernel/, *.vitest.ts, and any dist/ or node_modules/ directory (packages/*/scripts and packages/*/tests are outside the scanned roots). ' +
  'Files are parsed with the TypeScript compiler API, so comments and string literals never count. ' +
  "Rows: 'platform()' counts calls of the platform export of @platform/platform (src/platform/platform.ts) under whatever local name the file binds it to — `import { platform as p }` then p(), and `import * as P` then P.platform(), included; tryPlatform and unrelated bindings such as node:os platform excluded; 'setServices()' counts calls whose callee is setServices or ends in .setServices; 'new AbortController()' counts new-expressions on the identifier AbortController; " +
  "'import:<pkg>' counts import/export-from/import-equals/require()/import() specifiers exactly equal to the package name (type-only imports included, because they still pin the dependency); " +
  "'Effect.run*' counts calls named runPromise, runPromiseExit, runSync, runFork, or runCallback, and counts them ONLY below R1's boundary kinds (packages/extension/src/**, packages/desktop/src/**, packages/cli/src/**, packages/agent/src/**, or src/tools/**/*Tool.ts, the last recognised by the class that extends the imported defineTool). A run at one of those kinds is the destination, not debt, and is absent from this row, so converting a subsystem cannot raise it. Every file here belongs to the lane named for it in the closed 'debtLanes' register: --update refuses a below-boundary file the register does not already name, never adds a file to a row, and writes the lower of the committed count and the tree's); " +
  "'catch:effect-importer' counts, only in files with a runtime import specifier equal to effect or starting with effect/ or @effect/ (type-only imports and all-type specifier lists do not qualify), catch clauses plus .catch( calls, excluding the Effect.catch combinator. " +
  'Every row is a per-file allowlist of shrink-only counts: a count that rose, or a file absent from its row, fails. A count that shrank or a file that disappeared is stale headroom and also fails (unlike the dead-code ratchet, which only reports resolved findings), because a stale count is room a later PR could regrow into unnoticed; regenerate with `node scripts/check-effect-migration-ratchet.mjs --update` in the same PR. ' +
  "'debtLanes' maps each below-boundary 'Effect.run*' file to the lane that removes it; an entry whose file leaves the row is stale and --update drops it. " +
  'The PR that zeroes a row deletes the row. The same script fails on the presence of any `@adapter-until` marker in scope (owner ruling 2026-09-06: no temporary adapters), a hard check with no baseline.';

const compareCodePoints = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The import every real tool file carries, prefixed onto the cases below. */
const IMPORT_DEFINE = "import { defineTool } from '@tools/core/define';\n";

/** Sources whose `runsOnlyInExecute` the survey must report exactly. */
const EXECUTE_CASES = [
  // The run sits inside `execute()` on the class that declares the tool
  // contract: this is boundary kind (b), and the only shape that is.
  [
    `${IMPORT_DEFINE}class T extends defineTool({ name: "t" }) { protected execute(i) { return rt().runPromise(this.run(i)); } }\n`,
    true,
  ],
  // The same method on a class that is not a tool: a helper's `execute` is
  // its own method, not the tool's run edge.
  [
    `${IMPORT_DEFINE}class H { execute(i) { return rt().runPromise(this.run(i)); } }\n`,
    false,
  ],
  // A tool class, but the run is elsewhere in the file.
  [
    `${IMPORT_DEFINE}class T extends defineTool({ name: "t" }) { execute() {} }\nrt().runPromise(program);\n`,
    false,
  ],
  // An object literal's `execute` shorthand is not a tool edge.
  [
    `${IMPORT_DEFINE}const o = { execute() { return rt().runPromise(p); } };\n`,
    false,
  ],
  // A free function named execute is not a tool edge.
  [
    `${IMPORT_DEFINE}function execute() { return rt().runPromise(p); }\n`,
    false,
  ],
  // No run at all: nothing to admit.
  [
    `${IMPORT_DEFINE}class T extends defineTool({ name: "t" }) { execute(i) { return i; } }\n`,
    false,
  ],
  // The two-step shape structuredOutput.ts uses: the base is bound to a name
  // first, so the heritage clause is an identifier, not a call.
  [
    `${IMPORT_DEFINE}const G = defineTool({ name: "t" });\nclass T extends G { protected execute(i) { return rt().runPromise(this.run(i)); } }\n`,
    true,
  ],
  // The same shape over a name that is not a tool base.
  [
    `${IMPORT_DEFINE}const G = makeThing();\nclass T extends G { protected execute(i) { return rt().runPromise(this.run(i)); } }\n`,
    false,
  ],
  // A name bound twice, once to something else: not resolved lexically, so
  // not trusted — the run counts as debt rather than gaining boundary status.
  [
    `${IMPORT_DEFINE}const G = makeOtherBase();\nfunction f() { const G = defineTool({ name: "t" }); return G; }\nclass H extends G { execute(i) { return rt().runPromise(this.run(i)); } }\n`,
    false,
  ],
  // `defineTool` declared locally rather than imported from the tool core: an
  // unrelated function of the same name cannot present a helper as the tool.
  [
    'function defineTool(x) { return class {}; }\nclass H extends defineTool({ name: "t" }) { execute(i) { return rt().runPromise(this.run(i)); } }\n',
    false,
  ],
  // Imported under an alias: the binding is what counts, not the spelling.
  [
    `import { defineTool as make } from '@tools/core/define';\nclass T extends make({ name: "t" }) { protected execute(i) { return rt().runPromise(this.run(i)); } }\n`,
    true,
  ],
];

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
  const toolFactory = definedToolFactory(sourceFile);
  const generatedBases = generatedToolBases(sourceFile, toolFactory);
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
  let runsInExecute = 0;
  let runsOutsideExecute = 0;

  const visit = (node, inExecute) => {
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
      if (name != null && RUN_BOUNDARY_NAMES.has(name)) {
        bump(ROW_RUN_BOUNDARY);
        if (inExecute) runsInExecute += 1;
        else runsOutsideExecute += 1;
      }
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
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      // A tool's run edge is `execute()` on the tool class, and the tool
      // class is the one that extends `defineTool(...)` — every tool in the
      // repo is declared that way, so the contract is checkable rather than
      // guessed from a method name. Recurse with the flag set only through
      // that member's subtree, so a run elsewhere in the file is still
      // counted as below the boundary: in a sibling helper class, and in a
      // helper's own `execute` too, since a helper is not the tool. An
      // object literal's `execute` shorthand is the same AST node kind and
      // never sets the flag, because it is not a class member.
      const isTool = extendsDefineTool(node, generatedBases, toolFactory);
      ts.forEachChild(node, (child) =>
        visit(
          child,
          inExecute ||
            (isTool &&
              ts.isMethodDeclaration(child) &&
              ts.isIdentifier(child.name) &&
              child.name.text === 'execute'),
        ),
      );
      return;
    }
    ts.forEachChild(node, (child) => visit(child, inExecute));
  };
  visit(sourceFile, false);

  if (effectImporter && catches > 0) counts.set(ROW_CATCH, catches);
  // A file is a tool run edge when it runs Effects and every one of them sits
  // inside an `execute()` class method — not merely when such a method exists.
  const runsOnlyInExecute = runsInExecute > 0 && runsOutsideExecute === 0;
  return { counts, runsOnlyInExecute };
}

/**
 * Names bound in this file to a `defineTool(...)` call, so the two-step shape
 * `const GeneratedTool = defineTool({ ... })` followed by `class X extends
 * GeneratedTool` is recognised as the tool contract too. `structuredOutput.ts`
 * builds its terminal tool that way, and a heritage clause that is a bare
 * identifier is otherwise indistinguishable from extending any other class.
 */
/**
 * The local name `defineTool` is bound to under an import from the tool core
 * (`@tools/core/define`, or the relative forms of the same module). Matching
 * the identifier text alone would let a file that declares its own unrelated
 * `defineTool` present a helper class as the tool contract, which filters its
 * runs out of the ratchet entirely -- the one direction this check must never
 * be wrong in. Returns null when the file imports no such binding.
 */
function definedToolFactory(sourceFile) {
  let local = null;
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !TOOL_DEFINE_MODULES.has(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const named = statement.importClause?.namedBindings;
    if (named == null || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'defineTool') local = element.name.text;
    }
  }
  return local;
}

function generatedToolBases(sourceFile, factory) {
  const fromDefineTool = new Set();
  const shadowed = new Set();
  if (factory == null) return fromDefineTool;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const init = node.initializer;
      const isBase =
        init != null &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === factory;
      // A name bound more than once in the file is not resolved lexically
      // here, so it is not trusted at all: if any binding of it is something
      // other than defineTool(...), the name stops counting as a tool base.
      // That fails closed -- the class is treated as a helper, its runs count
      // as debt, and the register demands a lane -- which is the safe
      // direction for a check whose whole job is refusing to widen.
      if (isBase) fromDefineTool.add(name);
      else shadowed.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const name of shadowed) fromDefineTool.delete(name);
  return fromDefineTool;
}

/**
 * Whether a class declares the tool contract: `class X extends defineTool({
 * ... })` directly, or `extends <a local name bound to defineTool(...)>`.
 * Every tool in `src/tools/` is written one of those two ways, which is what
 * makes "is this the tool class?" a question the AST can answer instead of a
 * guess from the name of a method.
 */
function extendsDefineTool(node, generatedBases, factory) {
  if (factory == null) return false;
  return (node.heritageClauses ?? []).some(
    (clause) =>
      clause.token === ts.SyntaxKind.ExtendsKeyword &&
      clause.types.some(
        (type) =>
          (ts.isCallExpression(type.expression) &&
            ts.isIdentifier(type.expression.expression) &&
            type.expression.expression.text === factory) ||
          (ts.isIdentifier(type.expression) &&
            (generatedBases?.has(type.expression.text) ?? false)),
      ),
  );
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

/** Survey the tree: { rows: { rowId: { file: count } }, texts: { file: text } }. */
function surveyTree(files) {
  const rows = Object.fromEntries(ROWS.map((row) => [row.id, {}]));
  const texts = new Map();
  const toolExecuteFiles = new Set();
  for (const file of files) {
    const text = readFileSync(join(rootDir, file), 'utf8');
    texts.set(file, text);
    const { counts, runsOnlyInExecute } = surveySource(text, file);
    for (const [row, count] of counts) {
      rows[row][file] = count;
    }
    if (runsOnlyInExecute && file.startsWith(BOUNDARY_TOOL_ROOT)) {
      toolExecuteFiles.add(file);
    }
  }
  // The `Effect.run*` row is the debt, and a run at one of R1's boundary kinds
  // is not debt -- it is the destination. Counting those too is what made
  // every conversion lane widen this baseline: runs MOVE to a host entry, so
  // the entry's count rises, and the ratchet then had to be argued with
  // rather than obeyed. Dropping them makes "this row only ever shrinks" true
  // by construction instead of by exception, and leaves the row's keys equal
  // to the register's.
  rows[ROW_RUN_BOUNDARY] = Object.fromEntries(
    Object.entries(rows[ROW_RUN_BOUNDARY]).filter(
      ([file]) => !isBoundaryPath(file, toolExecuteFiles),
    ),
  );
  return { rows, texts, toolExecuteFiles };
}

/**
 * `@adapter-until` markers. There are no temporary adapters (owner ruling
 * 2026-09-06), so the presence of a marker anywhere in production scope
 * fails; the date after it, if any, is irrelevant.
 */
function checkAdapterMarkers(texts) {
  const failures = [];
  for (const [file, text] of texts) {
    text.split('\n').forEach((line, index) => {
      if (/@adapter-until\b/.test(line)) {
        failures.push(
          `${file}:${index + 1}: @adapter-until marker present — the owner ruled on 2026-09-06 "fully embrace Effect. No more pass-throughs nor adapters" (${PRD} R1, second ruling; execution rule 3): there are no temporary adapters to date, so the adapter is deleted by converting the port and its callers to Effect`,
        );
      }
    });
  }
  return failures;
}

/** Placeholder `--update` writes for a below-boundary file with no lane yet. */
const UNASSIGNED_LANE = 'UNASSIGNED';

/**
 * The `debtLanes` map for the `Effect.run*` row: every below-boundary file
 * currently running an Effect, mapped to the lane that deletes it. Lanes
 * already named in the committed baseline are carried forward; a file that
 * is new, or that the baseline never named, gets `UNASSIGNED`, which the
 * check rejects — so a PR that adds a below-boundary run site must name its
 * owning lane in the same PR rather than quietly widening an allowlist. A
 * file that has left the row is dropped.
 */
function runBoundaryDebtLanes(current, committedLanes, toolExecuteFiles) {
  const lanes = {};
  for (const file of Object.keys(current)) {
    if (isBoundaryPath(file, toolExecuteFiles)) continue;
    lanes[file] = committedLanes?.[file] ?? UNASSIGNED_LANE;
  }
  return lanes;
}

/** Below-boundary files whose lane is missing or still the placeholder. */
function unassignedDebt(current, lanes, toolExecuteFiles) {
  return Object.keys(current)
    .filter((file) => !isBoundaryPath(file, toolExecuteFiles))
    .filter((file) => {
      const lane = lanes?.[file];
      return (
        typeof lane !== 'string' ||
        lane.trim() === '' ||
        lane === UNASSIGNED_LANE
      );
    });
}

/**
 * Lane entries the register no longer needs: a file the map names that is no
 * longer below the boundary — converted, moved into a recognized `execute()`,
 * or deleted. `diffRows` cannot see this, because a run that merely moves
 * inside its own file leaves the counted total untouched; only the lane map
 * goes stale. Rejecting it keeps the register a statement about the debt that
 * exists now rather than an archive of debt that once did.
 */
function staleDebtLanes(current, lanes, toolExecuteFiles) {
  const below = new Set(
    Object.keys(current).filter(
      (file) => !isBoundaryPath(file, toolExecuteFiles),
    ),
  );
  return Object.keys(lanes ?? {})
    .filter((file) => !below.has(file))
    .toSorted(compareCodePoints);
}

/** Fail the ratchet itself if the marker scan or the boundary gate regresses. */
function selfTestBoundaryAndMarkers() {
  const markerFailures = checkAdapterMarkers(
    new Map([
      [
        'src/agent/probe.ts',
        '// @adapter-until 2026-12-01\nx();\n/* @adapter-until */\nconst s = "adapter-until";\n',
      ],
      ['src/agent/clean.ts', '// no marker here\n'],
    ]),
  );
  const markerWhere = markerFailures.map((f) =>
    f.slice(0, f.indexOf(':', f.indexOf(':') + 1)),
  );
  if (
    JSON.stringify(markerWhere) !==
      JSON.stringify(['src/agent/probe.ts:1', 'src/agent/probe.ts:3']) ||
    !markerFailures.every((f) =>
      f.includes('No more pass-throughs nor adapters'),
    )
  ) {
    console.error(
      'checkAdapterMarkers self-test failed:',
      JSON.stringify(markerFailures),
    );
    process.exit(1);
  }

  const boundaryCases = [
    ['packages/extension/src/commands/run.ts', true],
    ['packages/desktop/src/main/ipc.ts', true],
    ['packages/cli/src/chat/tui/App.tsx', true],
    ['packages/agent/src/index.ts', true],
    ['src/tools/EditTool.ts', true],
    ['src/tools/arxiv/SearchTool.ts', true],
    ['src/tools/goal/goalStore.ts', false],
    ['src/tools/bash.ts', false],
    // A tool class whose file is not named *Tool.ts is still boundary (b):
    // the survey reports that it declares an execute() method.
    ['src/tools/claudeAgent.ts', true, new Set(['src/tools/claudeAgent.ts'])],
    // The same set never promotes a file outside src/tools/.
    [
      'src/controllers/session/sessionLayer.ts',
      false,
      new Set(['src/controllers/session/sessionLayer.ts']),
    ],
    ['src/agent/runtime/SessionHandle.ts', false],
    ['src/controllers/session/SessionBridge.ts', false],
    ['packages/trace-viewer/src/main.ts', false],
    // A webview frontend sits under a host package but is a VS Code-free
    // zone, not a host entry, so R1 does not admit a run there.
    ['packages/extension/src/progressView/frontend/sessionTransport.ts', false],
    ['packages/extension/src/webview/frontend/app.ts', false],
    ['packages/extension/src/settingsView/frontend/settings.ts', false],
    // The extension-host frontend (no view-name segment) is host code and
    // stays a boundary — the two are easy to confuse, so both are pinned.
    ['packages/extension/src/frontend/auth/subscriptionSignIn.ts', true],
  ];
  for (const [file, expected, executeFiles] of boundaryCases) {
    if (isBoundaryPath(file, executeFiles) !== expected) {
      console.error(
        `isBoundaryPath self-test failed: ${file} expected ${expected}`,
      );
      process.exit(1);
    }
  }

  for (const [text, expected] of EXECUTE_CASES) {
    if (
      surveySource(text, 'src/tools/probe.ts').runsOnlyInExecute !== expected
    ) {
      console.error(
        `runsOnlyInExecute self-test failed for ${JSON.stringify(text)}`,
      );
      process.exit(1);
    }
  }

  const debtRow = {
    'src/agent/runtime/newRunner.ts': 1,
    'packages/cli/src/commands/newCommand.ts': 2,
    'src/tools/NewTool.ts': 1,
    'src/tools/goal/goalStore.ts': 3,
  };
  const lanes = runBoundaryDebtLanes(
    debtRow,
    {
      'src/tools/goal/goalStore.ts': 'lane D',
      'src/agent/runtime/gone.ts': 'lane D',
    },
    new Set(),
  );
  if (
    JSON.stringify(lanes) !==
    JSON.stringify({
      'src/agent/runtime/newRunner.ts': UNASSIGNED_LANE,
      'src/tools/goal/goalStore.ts': 'lane D',
    })
  ) {
    console.error(
      'runBoundaryDebtLanes self-test failed:',
      JSON.stringify(lanes),
    );
    process.exit(1);
  }
  if (
    JSON.stringify(unassignedDebt(debtRow, lanes)) !==
    JSON.stringify(['src/agent/runtime/newRunner.ts'])
  ) {
    console.error('unassignedDebt self-test failed');
    process.exit(1);
  }
  const stale = staleDebtLanes(
    debtRow,
    {
      'src/agent/runtime/newRunner.ts': UNASSIGNED_LANE,
      'src/tools/goal/goalStore.ts': 'lane D',
      'src/tools/lean/lspTools.ts': 'Lean LSP follow-up',
      'packages/cli/src/main.ts': 'host entry',
    },
    new Set(),
  );
  if (
    JSON.stringify(stale) !==
    JSON.stringify(['packages/cli/src/main.ts', 'src/tools/lean/lspTools.ts'])
  ) {
    console.error('staleDebtLanes self-test failed:', JSON.stringify(stale));
    process.exit(1);
  }
}

const BASELINE_MISSING = `Baseline missing: ${baselinePath}. Restore it from git; it cannot be regenerated from scratch, because the lane names in its debtLanes map are written by hand and --update cannot recover them.`;

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
  // Absent means an empty register, which is the end state the migration is
  // aiming at: no run below a boundary, so no lane to name. writeBaseline
  // omits the key in exactly that case, so the two must agree.
  const debtLanes = parsed?.debtLanes ?? {};
  if (
    typeof debtLanes !== 'object' ||
    Array.isArray(debtLanes) ||
    Object.values(debtLanes).some((lane) => typeof lane !== 'string')
  ) {
    throw new Error(
      `Baseline debtLanes is not a map of file to lane name: ${baselinePath}. Run --update, then name each lane.`,
    );
  }
  if (parsed.semantics !== SEMANTICS) {
    throw new Error(
      `Baseline semantics text is out of date with the script: ${baselinePath}. Run --update.`,
    );
  }
  return parsed;
}

/**
 * The committed counts and lane keys, read for `--update`'s own gates.
 *
 * Deliberately looser than {@link readBaseline}: that one rejects a baseline
 * whose `semantics` text or row set has drifted from the script and tells the
 * reader to run `--update` — which would then call it and hit the same
 * rejection, so a legitimate script edit could never be recorded. The gates
 * need only the previous per-file counts and which files the register already
 * names; a row the script has since added simply has nothing committed yet.
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
  return {
    rows: Object.fromEntries(
      ROWS.map((row) => [row.id, has(row.id) ? committed[row.id] : {}]),
    ),
    // Rows the committed baseline does not carry at all. A row the script has
    // just gained has no ceiling to respect yet, so `--update` seeds it from
    // the tree; without the distinction, "never add a file" would write it
    // empty and then report every real entry as new, and the row could never
    // be introduced at all.
    unseeded: new Set(ROWS.map((row) => row.id).filter((id) => !has(id))),
    debtLanes:
      typeof parsed?.debtLanes === 'object' && parsed.debtLanes !== null
        ? parsed.debtLanes
        : {},
  };
}

function writeBaseline(rows, debtLanes) {
  const sortedRows = Object.fromEntries(
    ROWS.map((row) => [row.id, sortObject(rows[row.id])]),
  );
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      Object.keys(debtLanes).length === 0
        ? { semantics: SEMANTICS, rows: sortedRows }
        : {
            semantics: SEMANTICS,
            rows: sortedRows,
            debtLanes: sortObject(debtLanes),
          },
      null,
      2,
    )}\n`,
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
  const options = { update: false };
  for (const arg of argv) {
    if (arg === '--update') {
      options.update = true;
    } else {
      throw new Error(
        `Unknown argument ${JSON.stringify(arg)}; expected --update or nothing`,
      );
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  selfTestSurvey();
  selfTestBoundaryAndMarkers();
  const files = productionFiles();
  const { rows, texts, toolExecuteFiles } = surveyTree(files);
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
    const { failures: grew } = diffRows(rows, committed.rows);
    if (grew.length > 0) {
      console.error(
        `\n${grew.length} count(s) grew; the baseline keeps the committed ceiling for each and the check stays red until they are gone.`,
      );
      for (const { row, file, was, now, kind } of grew) {
        console.error(`  - [${row.id}] ${file}: ${was} -> ${now} (${kind})`);
      }
    }

    const admitted = new Set(Object.keys(committed.debtLanes ?? {}));
    const newDebt = Object.keys(rows[ROW_RUN_BOUNDARY])
      .filter((file) => !admitted.has(file))
      .toSorted(compareCodePoints);
    if (newDebt.length > 0) {
      console.error(
        `\n--update refused: ${newDebt.length} file(s) would enter the below-boundary register that the committed baseline does not already name.`,
      );
      for (const file of newDebt)
        console.error(`  - ${file} is ${BELOW_BOUNDARY}.`);
      console.error(
        `\nThe register records the debt that already existed when it was written; it is not an intake. Convert the file and its callers so the run moves to one of ${BOUNDARY_PATHS_TEXT} (owner ruling 2026-09-06: never widen a ratchet in config/ratchets/ — naming future work does not create an exception).`,
      );
      process.exit(1);
    }

    // Every written count is the lower of the committed one and the tree's,
    // and a file the row does not already carry is not added at all, so this
    // command cannot raise a ceiling or open a new one. A file that is new to
    // a row is new debt: the check reports it and stays red until it is gone,
    // which is the only outcome that does not quietly bless it.
    const tightened = Object.fromEntries(
      ROWS.map((row) => [
        row.id,
        committed.unseeded.has(row.id)
          ? rows[row.id]
          : Object.fromEntries(
              Object.entries(rows[row.id])
                .filter(([file]) => committed.rows[row.id]?.[file] != null)
                .map(([file, count]) => [
                  file,
                  Math.min(committed.rows[row.id][file], count),
                ]),
            ),
      ]),
    );
    // The register is built from the SURVEY, not from `tightened`. The row
    // holds ceilings and refuses a file it does not already carry; the
    // register holds the debt that exists right now and who deletes it. Those
    // are different things, and building the register from the row dropped
    // the lane name of any file the row had refused -- leaving the check
    // demanding a name that --update would wipe on its next run.
    const lanes = runBoundaryDebtLanes(
      rows[ROW_RUN_BOUNDARY],
      committed.debtLanes ?? {},
      toolExecuteFiles,
    );
    writeBaseline(tightened, lanes);
    console.log(`Effect migration baseline written: ${baselinePath}`);
    const pending = unassignedDebt(
      rows[ROW_RUN_BOUNDARY],
      lanes,
      toolExecuteFiles,
    );
    if (pending.length > 0) {
      console.log(
        `\n${pending.length} below-boundary Effect.run* file(s) need a lane name in debtLanes ` +
          `(replace ${UNASSIGNED_LANE}); the check fails until each is named:`,
      );
      for (const file of pending) console.log(`  - ${file}`);
    }
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
      if (
        row.id === ROW_RUN_BOUNDARY &&
        !isBoundaryPath(file, toolExecuteFiles)
      ) {
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

  const debtLanes = baseline.debtLanes ?? {};
  const debtFiles = Object.keys(rows[ROW_RUN_BOUNDARY])
    .filter((file) => !isBoundaryPath(file, toolExecuteFiles))
    .toSorted(compareCodePoints);
  if (debtFiles.length > 0) {
    console.log(
      `\nEffect.run* below the boundary (${debtFiles.length} file(s)), each owned by the lane that deletes it:`,
    );
    for (const file of debtFiles) {
      console.log(
        `  - ${file}: ${rows[ROW_RUN_BOUNDARY][file]} site(s) — ${debtLanes[file] ?? UNASSIGNED_LANE}`,
      );
    }
  }
  const pendingDebt = unassignedDebt(
    rows[ROW_RUN_BOUNDARY],
    debtLanes,
    toolExecuteFiles,
  );
  if (pendingDebt.length > 0) {
    failed = true;
    console.error(
      `\nEffect migration ratchet failed: ${pendingDebt.length} below-boundary Effect.run* file(s) have no lane named in debtLanes.`,
    );
    for (const file of pendingDebt) {
      console.error(`  - ${file} is ${BELOW_BOUNDARY}.`);
    }
    console.error(
      `\nName the lane that deletes each one in the baseline's debtLanes map (replace ${UNASSIGNED_LANE}), or convert the file and its callers in this PR.`,
    );
  }

  const staleLanes = staleDebtLanes(
    rows[ROW_RUN_BOUNDARY],
    debtLanes,
    toolExecuteFiles,
  );
  if (staleLanes.length > 0) {
    failed = true;
    console.error(
      `\nEffect migration ratchet failed: debtLanes names ${staleLanes.length} file(s) that are no longer below the boundary.`,
    );
    for (const file of staleLanes) {
      console.error(
        `  - ${file}: ${debtLanes[file]} — the debt is gone, the entry is not.`,
      );
    }
    console.error(
      '\nGood news; lock it in: run `node scripts/check-effect-migration-ratchet.mjs --update` and commit the baseline in this PR.',
    );
  }

  const markers = checkAdapterMarkers(texts);
  if (markers.length > 0) {
    failed = true;
    console.error(
      `\n@adapter-until check failed: ${markers.length} marker(s) present; there are no temporary adapters.`,
    );
    for (const failure of markers) console.error(`  - ${failure}`);
  } else {
    console.log('@adapter-until markers OK: none present.');
  }

  if (failed) process.exit(1);
  console.log(
    'Effect migration ratchet OK: no count grew, no baseline headroom.',
  );
}

main();
