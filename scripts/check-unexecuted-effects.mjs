#!/usr/bin/env node
// Unexecuted-Effect gate — GitHub issue #12491, adopted per the measurement
// recorded on #12424 (2026-09-15): current main scans ZERO sites on both the
// production and test surfaces, so this gate has no baseline and no allowlist
// — every hit is a new regression and a hard error from day one.
//
// The defect class: under this repo's TypeScript configuration `await <Effect>`
// typechecks and silently does nothing (the write is dropped, nothing logs,
// the caller reports success), and grep cannot find it because `await
// someEffect` and `await somePromiseCall(...)` look identical. tsc is not an
// oracle for Promise-to-Effect conversions; this type-aware scan is. It walks
// every project config `npm run typecheck` composes with the TypeScript
// compiler API (the repo's `typescript` devDependency) and flags four shapes:
//
//   1. `await <Effect>`           — the awaited value is the un-run Effect
//   2. `void <Effect>`            — "fire and forget" that never fires
//   3. `<Effect>;`                — an expression statement discards it.
//       Statements that STORE the Effect (assignments, including ??=) or
//       EXECUTE it (`yield*` inside Effect.gen) are not this shape: an Effect
//       is a value the tree passes around deliberately (claim releases,
//       `let program; program = this.executeGoal(...)`), and a syntax scan
//       cannot tell a stored Effect that is run later from one that is not.
//   4. an Effect returned directly from the thunk of `Effect.tryPromise` /
//      `Effect.promise`. Only the direct form: a thunk returning
//      Promise<Effect> (async or not) is accepted because the produced Effect
//      may be executed by a later statement (`const projected = yield*
//      Effect.promise(...); yield* projected;` is a real pattern), which this
//      scan cannot distinguish from a dropped one.
//
// An expression is an Effect when its type carries the `~effect/Effect`
// TypeId property (effect/Effect's `[TypeId]` variance key) AND its apparent
// type's symbol is the effect package's `Effect` interface itself — the
// property check alone also matches effect's yieldable lookalikes (`Exit`,
// `Data.TaggedError` classes), which are data, not unexecuted programs.
// Unions are recursed through. Promise-typed awaits, `Effect.run*` runs,
// yieldable values, and `Effect.try` (a synchronous adapter whose contract
// is not PromiseLike) are legitimate and do not fire.
//
// Scope notes, earned from the branch measurements on #12424: one program per
// project config (a merged file list crashed the checker and mixes module
// resolutions); the root tsconfig.json EXCLUDES src/test-kernel, so the test
// surface is scanned through tsconfig.test-kernel.json; a file shared by
// several programs is scanned once, under the first config that owns it (the
// configs are ordered so each file's home config comes first). Every listed
// config must exist and parse — a missing one fails the gate, so a renamed
// config cannot quietly shrink the scanned surface.

import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The configs `npm run typecheck` composes, in home-config-first order:
 * tsconfig.json owns src/** and packages/extension/src/**,
 * tsconfig.test-kernel.json owns the test surface the root config excludes,
 * tsconfig.build.json owns packages/agent/src (typecheck:agent runs the
 * package build, whose tsc step is this config), and each remaining package
 * config owns its package's sources.
 */
const PROJECT_CONFIGS = [
  'tsconfig.json',
  'tsconfig.test-kernel.json',
  'tsconfig.build.json',
  'packages/llm/tsconfig.json',
  'packages/cli/tsconfig.json',
  'packages/cli/tsconfig.scripts.json',
  'packages/trace-viewer/tsconfig.json',
  'packages/desktop/tsconfig.json',
  'packages/desktop/tsconfig.main.json',
  'packages/desktop/tsconfig.preload.json',
  'packages/desktop/tsconfig.renderer.json',
  'packages/desktop/tsconfig.tooling.json',
];

const EFFECT_TYPE_ID = '~effect/Effect';
const THUNK_ADAPTER_NAMES = new Set(['tryPromise', 'promise']);
const ISSUE = 'https://github.com/LionSR/TeXRA/issues/12491';

/**
 * Whether a type is an Effect: it (or a union member) carries the
 * `~effect/Effect` TypeId variance key AND its apparent type's symbol is the
 * `Effect` interface declared by the effect package. The property alone is
 * not enough: effect's yieldable types (`Exit`, `Data.TaggedError` classes
 * and other `YieldableError`s) implement the Effect interface, so they carry
 * the same TypeId key, yet assigning or storing one is ordinary data flow —
 * only a value whose type IS the Effect interface is an unexecuted program.
 * Name-based matching alone would false-positive on an unrelated `Effect`
 * declaration and false-negative on an aliased import; property plus symbol
 * survives both.
 */
function makeIsEffectType(checker) {
  const isEffectType = (type, seen = new Set()) => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isUnion())
      return type.types.some((member) => isEffectType(member, seen));
    const apparent = checker.getApparentType(type);
    if (apparent.getProperty(EFFECT_TYPE_ID) == null) return false;
    const symbol = apparent.getSymbol?.() ?? apparent.symbol;
    if (symbol?.name !== 'Effect') return false;
    return (symbol.declarations ?? []).some((declaration) => {
      const fileName = declaration.getSourceFile().fileName;
      return (
        fileName.includes(`${sep}effect${sep}`) &&
        fileName.endsWith(`${sep}Effect.d.ts`)
      );
    });
  };
  return isEffectType;
}

/**
 * Whether a callee name node (`Effect.tryPromise`'s `tryPromise`, or a
 * directly imported `tryPromise`) resolves to the `tryPromise`/`promise`
 * export of effect's Effect module, under any import alias. Symbol
 * declarations, not names, decide: a repo-local function of the same name
 * declares elsewhere.
 */
function isEffectThunkAdapter(checker, nameNode) {
  const name = ts.isIdentifier(nameNode) ? nameNode.text : null;
  if (name == null || !THUNK_ADAPTER_NAMES.has(name)) return false;
  let symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol == null) return false;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return (symbol.declarations ?? []).some((declaration) => {
    const fileName = declaration.getSourceFile().fileName;
    return (
      fileName.includes(`${sep}effect${sep}`) &&
      fileName.endsWith(`${sep}Effect.d.ts`)
    );
  });
}

/**
 * The function whose return value a tryPromise/promise call adapts: the first
 * argument when it is itself the thunk, or the `try` member of the options
 * object overload. Null when the call has neither form.
 */
function adapterThunk(call) {
  const argument = call.arguments[0];
  if (argument == null) return null;
  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
    return argument;
  }
  if (ts.isObjectLiteralExpression(argument)) {
    for (const property of argument.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === 'try' &&
        (ts.isArrowFunction(property.initializer) ||
          ts.isFunctionExpression(property.initializer))
      ) {
        return property.initializer;
      }
      if (
        ts.isMethodDeclaration(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === 'try'
      ) {
        return property;
      }
    }
  }
  return null;
}

const KIND_TEXT = {
  awaited:
    'await of an Effect: awaiting does not execute it — the awaited value is the un-run Effect and the work is silently dropped',
  voided:
    'void of an Effect: the discard operator does not execute it — the work is silently dropped',
  discarded:
    'an Effect as an expression statement: nothing executes it — the work is silently dropped',
  thunk:
    "an Effect returned from the thunk of Effect.tryPromise/Effect.promise: the adapter awaits the thunk's Promise, not the inner Effect, which is never executed",
};

/**
 * The unexecuted-Effect sites in one source file: [{ kind, line, character,
 * detail }], line/character 1-based. Shapes are mutually exclusive: the
 * statement check skips `await`/`void` expressions (shapes 1 and 2 already
 * reported them, and `await` of a non-thenable keeps the operand's type, so
 * the statement would otherwise re-report the same site), assignments (they
 * store the Effect — a value the tree passes around deliberately, run later
 * by its consumer; compound assignments included), and `yield`/`yield*`
 * statements (the generator driver executes them). Logical/comma discards
 * (`enabled && someEffect;`) are still this shape.
 */
function isAssignmentExpression(node) {
  if (!ts.isBinaryExpression(node)) return false;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.EqualsToken:
    case ts.SyntaxKind.PlusEqualsToken:
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.PercentEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
    case ts.SyntaxKind.BarBarEqualsToken:
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
      return true;
    default:
      return false;
  }
}

function scanSourceFile(checker, sourceFile) {
  const isEffectType = makeIsEffectType(checker);
  const findings = [];
  const record = (kind, node, detail) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    findings.push({ kind, line: line + 1, character: character + 1, detail });
  };
  const visit = (node) => {
    if (ts.isAwaitExpression(node)) {
      const type = checker.getTypeAtLocation(node.expression);
      if (isEffectType(type))
        record('awaited', node, checker.typeToString(type));
    } else if (node.kind === ts.SyntaxKind.VoidExpression) {
      const type = checker.getTypeAtLocation(node.expression);
      if (isEffectType(type))
        record('voided', node, checker.typeToString(type));
    } else if (
      ts.isExpressionStatement(node) &&
      !ts.isAwaitExpression(node.expression) &&
      node.expression.kind !== ts.SyntaxKind.VoidExpression &&
      !ts.isYieldExpression(node.expression) &&
      !isAssignmentExpression(node.expression)
    ) {
      const type = checker.getTypeAtLocation(node.expression);
      if (isEffectType(type)) {
        record('discarded', node, checker.typeToString(type));
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const nameNode = ts.isPropertyAccessExpression(callee)
        ? callee.name
        : ts.isIdentifier(callee)
          ? callee
          : null;
      if (nameNode != null && isEffectThunkAdapter(checker, nameNode)) {
        const thunk = adapterThunk(node);
        if (thunk != null) {
          const signatures = checker
            .getTypeAtLocation(thunk)
            .getCallSignatures();
          if (signatures.length === 1) {
            const returnType = checker.getReturnTypeOfSignature(signatures[0]);
            if (isEffectType(returnType)) {
              record('thunk', node, checker.typeToString(returnType));
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

/** Whether a program source file is repo code this gate answers for. */
function isScannedFile(fileName) {
  return (
    fileName.startsWith(rootDir + sep) &&
    !fileName.includes(`${sep}node_modules${sep}`) &&
    !fileName.endsWith('.d.ts')
  );
}

/** Parse one project config, failing the gate on a missing or broken one. */
function parseProjectConfig(configRel) {
  const configPath = join(rootDir, configRel);
  if (!existsSync(configPath)) {
    throw new Error(
      `Project config missing: ${configRel}. The gate scans exactly the configs \`npm run typecheck\` composes; a renamed config must be renamed here too, or the scanned surface shrinks unnoticed.`,
    );
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        `Project config unreadable: ${configRel}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      );
    },
  });
  if (parsed == null) {
    throw new Error(`Project config unparsable: ${configRel}.`);
  }
  if (parsed.errors.length > 0) {
    const text = parsed.errors
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      )
      .join('; ');
    throw new Error(`Project config has errors: ${configRel}: ${text}`);
  }
  return parsed;
}

/** Fail the gate itself if the classifiers regress. */
function selfTest() {
  const probe = `
import { Effect } from 'effect';
import * as E from 'effect';
import { Data, Exit } from 'effect';
import { tryPromise } from 'effect/Effect';

declare const eff: Effect.Effect<number, Error>;
declare const cond: boolean;
declare function tryPromiseLocal(thunk: () => unknown): void;
class ProbeError extends Data.TaggedError('ProbeError')<{}> {}
declare const err: ProbeError;
declare const exit: Exit.Exit<number, Error>;

async function awaited() {
  await eff; // awaited
  await (cond ? eff : Promise.resolve(2)); // awaited (union member)
  await Promise.resolve(1); // clean: a real Promise
}

function discarded() {
  eff; // discarded
  void eff; // voided
  Effect.runSync(eff); // clean: run, returns A
  Effect.runPromise(eff); // clean: run, returns Promise<A>
}

const direct = Effect.tryPromise(() => eff); // thunk
const namespaced = E.Effect.promise(() => eff); // thunk
const imported = tryPromise(() => eff); // thunk
const objectForm = Effect.tryPromise({ try: () => eff, catch: () => 'e' }); // thunk
const asyncThunk = Effect.tryPromise(async () => eff); // clean: Promise<Effect> may be executed by a later statement
const okDirect = Effect.tryPromise(() => Promise.resolve(1)); // clean
const okAsync = Effect.tryPromise(async () => 1); // clean
const okObject = Effect.tryPromise({ try: () => Promise.resolve(1), catch: () => 'e' }); // clean
const syncAdapter = Effect.try(() => eff); // clean: Effect.try is not a Promise boundary
tryPromiseLocal(() => eff); // clean: not effect's adapter
err; // clean: a yieldable error class is data, not an unexecuted program
exit; // clean: Exit is a result value
await err; // clean
const okExitThunk = Effect.tryPromise(async () => exit); // clean: awaited value is an Exit

let stored: Effect.Effect<number, Error>;
stored = eff; // clean: an assignment stores the Effect for its consumer
const gen = Effect.gen(function* () {
  yield* eff; // clean: the gen driver executes it
});
`;
  // A virtual file inside the repo so module resolution finds the repo's
  // node_modules; never written to disk. Deliberately not dot-prefixed: the
  // #12424 measurement lost a fixture to a leading-dot name that no include
  // glob admitted.
  const probePath = join(rootDir, 'virtual-unexecuted-effect-probe.ts');
  const options = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === probePath
      ? ts.createSourceFile(fileName, probe, languageVersion, true)
      : realGetSourceFile(fileName, languageVersion, ...rest);
  host.fileExists = (fileName) =>
    fileName === probePath || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    fileName === probePath ? probe : ts.sys.readFile(fileName);
  const program = ts.createProgram([probePath], options, host);
  const probeFile = program.getSourceFile(probePath);
  if (probeFile == null) {
    console.error(
      'unexecuted-Effect gate self-test failed: probe file did not enter the program',
    );
    process.exit(1);
  }
  // The probe's intentional violations include shapes tsc itself rejects
  // today (the direct-thunk form), so the only fatal probe diagnostics are
  // module-resolution failures: if `effect` does not resolve, every type is
  // an error type and the self-test would pass vacuously.
  const resolutionErrors = program
    .getSemanticDiagnostics(probeFile)
    .filter((diagnostic) => diagnostic.code === 2307);
  if (resolutionErrors.length > 0) {
    console.error(
      'unexecuted-Effect gate self-test failed: probe cannot resolve its imports (effect unreachable?):',
      resolutionErrors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
        .join('; '),
    );
    process.exit(1);
  }
  const expected = [
    ['awaited', 15],
    ['awaited', 16],
    ['discarded', 21],
    ['voided', 22],
    ['thunk', 27],
    ['thunk', 28],
    ['thunk', 29],
    ['thunk', 30],
  ];
  const actual = scanSourceFile(program.getTypeChecker(), probeFile).map(
    ({ kind, line }) => [kind, line],
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(
      'unexecuted-Effect gate self-test failed:',
      JSON.stringify({ actual, expected }),
    );
    process.exit(1);
  }
}

function main() {
  selfTest();
  const scanned = new Set();
  let fileCount = 0;
  const violations = [];
  for (const configRel of PROJECT_CONFIGS) {
    const parsed = parseProjectConfig(configRel);
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true },
    });
    const checker = program.getTypeChecker();
    for (const sourceFile of program.getSourceFiles()) {
      if (!isScannedFile(sourceFile.fileName)) continue;
      if (scanned.has(sourceFile.fileName)) continue;
      scanned.add(sourceFile.fileName);
      fileCount += 1;
      for (const finding of scanSourceFile(checker, sourceFile)) {
        violations.push({
          file: relative(rootDir, sourceFile.fileName),
          ...finding,
        });
      }
    }
  }
  console.log(
    `Unexecuted-Effect gate scanned ${fileCount} files across ${PROJECT_CONFIGS.length} project configs (production and test surfaces).`,
  );
  if (violations.length > 0) {
    console.error(
      `\nUnexecuted-Effect gate failed: ${violations.length} site(s). The baseline is zero (#12424 measurement, 2026-09-15), so every site is a new regression. An Effect that is never executed does no work and logs nothing — yield* it inside an Effect program, or settle it on the host's runtime at a boundary. See ${ISSUE}.`,
    );
    for (const { file, line, character, kind, detail } of violations) {
      console.error(`  - ${file}:${line}:${character} [${kind}] ${detail}`);
      console.error(`      ${KIND_TEXT[kind]}.`);
    }
    process.exit(1);
  }
  console.log(
    'Unexecuted-Effect gate OK: no awaited, voided, discarded, or adapter-thunk Effects.',
  );
}

main();
