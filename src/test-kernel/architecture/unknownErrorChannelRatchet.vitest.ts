// Untyped Effect error channels (Effect facility adoption,
// .agents/docs/proposed/simplification/2026-09-20-effect-facility-adoption.md
// section 2, step 5). The repo declares 120 `Data.TaggedError` classes and
// still fails about 220 signatures with `unknown`, which is the shape that
// forces the next reader to re-derive a tag with `instanceof`. This freezes
// the count per file so it can only come down.
//
// Same mechanism as the effect-migration ratchet: exact, shrink-only counts.
// A count that rose fails, a file absent from the baseline fails on its first
// site, and a count that shrank also fails — the leftover is room a later PR
// could regrow into unnoticed, so the PR that types a channel lowers the entry
// and the PR that types the last one in a file deletes the entry.
//
// Clones the checked-in-baseline + AST-scanning vitest pattern from
// hostAgentDeepImportRatchet.vitest.ts.

// Node imports
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  expectRealCoverage,
  parseSourceFile,
  productionFilesUnder,
  REPO_ROOT,
} from '../support/repoScan';

const BASELINE_FILE = 'config/ratchets/unknown-error-baseline.json';

interface UnknownErrorBaseline {
  semantics: string;
  files: Record<string, number>;
}

/** `src` plus every workspace package that has a source root. */
function productionRoots(): string[] {
  const packages = readdirSync(resolve(REPO_ROOT, 'packages'))
    .filter((name) => existsSync(resolve(REPO_ROOT, 'packages', name, 'src')))
    .map((name) => posix.join('packages', name, 'src'));
  return ['src', ...packages.toSorted((a, b) => a.localeCompare(b))];
}

/** `Effect.Effect`, the only spelling the repo uses for the type. */
function isEffectEffect(typeName: ts.EntityName): boolean {
  return (
    ts.isQualifiedName(typeName) &&
    ts.isIdentifier(typeName.left) &&
    typeName.left.text === 'Effect' &&
    typeName.right.text === 'Effect'
  );
}

/** `Effect.Effect<A, unknown, R>` sites in one file: the error channel is the
 *  second type argument, and only the bare `unknown` keyword counts — a union
 *  that merely contains `unknown` is not the shape this ratchet retires. */
function countUnknownErrorChannels(file: string): number {
  const sourceFile = parseSourceFile(resolve(REPO_ROOT, file), {
    setParentNodes: false,
  });
  let sites = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(node) &&
      isEffectEffect(node.typeName) &&
      node.typeArguments?.[1]?.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      sites += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

function currentCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of productionRoots()) {
    for (const file of productionFilesUnder(root)) {
      const sites = countUnknownErrorChannels(file);
      if (sites > 0) counts.set(file, sites);
    }
  }
  return counts;
}

function readBaseline(): UnknownErrorBaseline {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, BASELINE_FILE), 'utf8'),
  ) as UnknownErrorBaseline;
}

describe('unknown Effect error-channel ratchet', () => {
  const baseline = readBaseline();
  const current = currentCounts();
  const roots = productionRoots();

  it('scans the production tree it claims to', () => {
    expectRealCoverage(roots, 1000);
  });

  it('rejects a new file with an unknown error channel', () => {
    const added = [...current]
      .filter(([file]) => baseline.files[file] === undefined)
      .map(([file, sites]) => `  + ${file} (${sites})`)
      .toSorted((a, b) => a.localeCompare(b));
    expect(
      added,
      `File(s) with Effect.Effect<..., unknown, ...> that are not in ${BASELINE_FILE}:\n` +
        `${added.join('\n')}\n\n` +
        `Type the failure channel with the tagged error the path already raises; do not widen ${BASELINE_FILE}.`,
    ).toEqual([]);
  });

  it('rejects any per-file count that no longer matches the baseline', () => {
    const drifted = Object.entries(baseline.files)
      .filter(([file, count]) => (current.get(file) ?? 0) !== count)
      .map(([file, count]) => `  ${file}: ${count} -> ${current.get(file) ?? 0}`)
      .toSorted((a, b) => a.localeCompare(b));
    expect(
      drifted,
      `Per-file unknown-error counts drifted from ${BASELINE_FILE}:\n` +
        `${drifted.join('\n')}\n\n` +
        `A count that rose is new debt: type the channel instead. A count that ` +
        `fell is the welcome direction — lower the entry in this PR, and delete ` +
        `the entry when the file reaches zero.`,
    ).toEqual([]);
  });

  it('keeps the baseline sorted by path', () => {
    const keys = Object.keys(baseline.files);
    expect(keys, `${BASELINE_FILE} files`).toEqual(
      keys.toSorted((a, b) => a.localeCompare(b)),
    );
  });
});
