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
// combinator that absorbs any failure is generic in it instead.

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
});
