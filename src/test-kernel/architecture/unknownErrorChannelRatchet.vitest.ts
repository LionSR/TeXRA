// Untyped Effect error channels (Effect facility adoption,
// .agents/docs/proposed/simplification/2026-09-20-effect-facility-adoption.md
// section 2, step 5). An `unknown` failure channel is the shape that forces
// the next reader to re-derive a tag with `instanceof`. The shrink-only
// baseline this began as reached zero, so the rule is now absolute: no
// production signature spells its error channel `unknown`.
//
// Type the channel with the tagged error the path already raises; a port
// whose hosts each fail with their own surface's error takes `Error`, and a
// foreign rejection (a Promise, a thrown value) becomes one at the boundary
// with `ensureError` from `@utils/errors/errorMessage`, never `(e) => e`. A
// combinator that absorbs any failure is generic in it instead. The thunk
// forms `Effect.try(() => …)` / `Effect.tryPromise(() => …)` are the same
// hole spelled differently: they fail with `UnknownError`, whose message is a
// fixed "An error occurred in Effect.try" that hides the real one.

// Node imports
import { resolve } from 'node:path';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  expectRealCoverage,
  parseSourceFile,
  productionFilesUnder,
  productionRoots,
  REPO_ROOT,
} from '../support/repoScan';

/** The two spellings of an Effect's type the repo uses, both `<A, E, R>`:
 *  `Effect.Effect` and the `Effect.fn` generator's `Effect.fn.Return`. */
function isEffectType(typeName: ts.EntityName): boolean {
  if (!ts.isQualifiedName(typeName)) return false;
  const { left, right } = typeName;
  if (ts.isIdentifier(left))
    return left.text === 'Effect' && right.text === 'Effect';
  return (
    right.text === 'Return' &&
    ts.isIdentifier(left.left) &&
    left.left.text === 'Effect' &&
    left.right.text === 'fn'
  );
}

/** `Effect.Effect<A, unknown, R>` / `Effect.fn.Return<A, unknown, R>` sites
 *  in one file, as `line: text`: the error channel is the second type
 *  argument, and only the bare `unknown` keyword counts — a union that merely
 *  contains `unknown` is not the shape this rule retires. */
function unknownErrorChannels(file: string): string[] {
  const sourceFile = parseSourceFile(resolve(REPO_ROOT, file), {
    setParentNodes: false,
  });
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(node) &&
      isEffectType(node.typeName) &&
      node.typeArguments?.[1]?.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      sites.push(`${file}:${line + 1}: ${node.getText(sourceFile)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/**
 * The identity `catch` callbacks that stay: each joins a late promise
 * rejection and compares the raw value by identity (to `signal.reason`, a
 * primary failure, or a `ModelError`'s `cause`) before absorbing it, or
 * narrows it to one tag and dies otherwise. Wrapping it would break the
 * comparison, and no raw value reaches a typed channel. Counts are exact.
 */
const IDENTITY_CATCH_JOINS: Readonly<Record<string, number>> = {
  'packages/agent/src/effect/runtime.ts': 1,
  'packages/extension/src/frontend/lm/acquireVscodeLanguageModel.ts': 2,
  'packages/llm/src/openaiResponsesWebSocket.ts': 2,
  'packages/llm/src/transport.ts': 2,
  'src/latex/arxivProcessor.ts': 1,
};

/** The keys a foreign-rejection mapper is handed under: `Effect.try` /
 *  `tryPromise` take `catch`, `Stream.fromReadableStream` takes `onError`. */
const FAILURE_MAPPER_KEYS = new Set(['catch', 'onError']);

/** `(e) => e`, `(e: unknown) => e`, `(e) => { return e; }` or the
 *  `function` spelling of either: a mapper that hands the value on. */
function isIdentityMapper(node: ts.Node | undefined): boolean {
  if (
    node === undefined ||
    !(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) ||
    node.parameters.length !== 1
  )
    return false;
  const [param] = node.parameters;
  if (param === undefined || !ts.isIdentifier(param.name)) return false;
  let returned: ts.Node | undefined = node.body;
  if (ts.isBlock(node.body)) {
    const [only] = node.body.statements;
    returned =
      node.body.statements.length === 1 &&
      only !== undefined &&
      ts.isReturnStatement(only)
        ? only.expression
        : undefined;
  }
  while (returned !== undefined && ts.isParenthesizedExpression(returned))
    returned = returned.expression;
  return (
    returned !== undefined &&
    ts.isIdentifier(returned) &&
    returned.text === param.name.text
  );
}

/** Identity failure mappers in one file: under a `catch` / `onError` key, or
 *  as `Stream.fromAsyncIterable`'s positional error mapper. Each hands a
 *  foreign rejection on as `unknown` instead of constructing an `Error`. */
function identityCatches(file: string): number {
  const sourceFile = parseSourceFile(resolve(REPO_ROOT, file), {
    setParentNodes: false,
  });
  let sites = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      FAILURE_MAPPER_KEYS.has(node.name.text) &&
      isIdentityMapper(node.initializer)
    )
      sites += 1;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'fromAsyncIterable' &&
      isIdentityMapper(node.arguments[1])
    )
      sites += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** Names this file binds to a function: a `function` declaration, or a
 *  variable whose initializer is an arrow or `function` expression. */
function functionBindings(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    )
      names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** `Effect.try(fn)` / `Effect.tryPromise(fn)` sites in one file, as
 *  `line: text`: the thunk forms, whose failure is `UnknownError`. A bare
 *  identifier counts only when this file binds it to a function, so a
 *  hoisted `{ try, catch }` options object (the typed overload) passes. */
function thunkTries(file: string): string[] {
  const sourceFile = parseSourceFile(resolve(REPO_ROOT, file), {
    setParentNodes: false,
  });
  const functions = functionBindings(sourceFile);
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Effect' &&
      ['try', 'tryPromise'].includes(node.expression.name.text)
    ) {
      const [first] = node.arguments;
      if (
        first !== undefined &&
        (ts.isArrowFunction(first) ||
          ts.isFunctionExpression(first) ||
          (ts.isIdentifier(first) && functions.has(first.text)))
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        sites.push(`${file}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

describe('unknown Effect error-channel rule', () => {
  const roots = productionRoots();

  it('scans the production tree it claims to', () => {
    expectRealCoverage(roots, 1000);
  });

  it('rejects an Effect whose error channel is unknown', () => {
    const sites = roots.flatMap((root) =>
      productionFilesUnder(root).flatMap(unknownErrorChannels),
    );
    expect(
      sites,
      `Effect signature(s) with an unknown error channel:\n` +
        `${sites.map((site) => `  ${site}`).join('\n')}\n\n` +
        `Type the channel with the tagged error the path raises (Error for a ` +
        `host port; ensureError at a foreign boundary).`,
    ).toEqual([]);
  });

  it('rejects a catch callback that passes the rejection on unchanged', () => {
    const drifted = roots
      .flatMap((root) => productionFilesUnder(root))
      .map((file) => [file, identityCatches(file)] as const)
      .filter(([file, sites]) => sites !== (IDENTITY_CATCH_JOINS[file] ?? 0))
      .map(
        ([file, sites]) =>
          `  ${file}: ${IDENTITY_CATCH_JOINS[file] ?? 0} -> ${sites}`,
      );
    expect(
      drifted,
      `Identity failure mappers (catch/onError: (e) => e) drifted from IDENTITY_CATCH_JOINS:\n` +
        `${drifted.join('\n')}\n\n` +
        `Construct the failure instead: catch: ensureError, or the path's own ` +
        `tagged error. A count that fell: lower or delete the entry.`,
    ).toEqual([]);
  });

  it('rejects the thunk forms of Effect.try and Effect.tryPromise', () => {
    const sites = roots.flatMap((root) =>
      productionFilesUnder(root).flatMap(thunkTries),
    );
    expect(
      sites,
      `Effect.try / Effect.tryPromise called with a bare function:\n` +
        `${sites.map((site) => `  ${site}`).join('\n')}\n\n` +
        `Pass { try, catch: ensureError } (or the path's own tagged error): ` +
        `the thunk form fails with UnknownError, which hides the message.`,
    ).toEqual([]);
  });
});
