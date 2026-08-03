// #9590 Stage 5 store public-surface budget ratchet (proof obligation 10).
// The two transcript stores' public method counts are pinned by a checked-in
// baseline: equal is allowed, growth fails, and a genuine reduction should
// shrink config/ratchets/store-public-surface-baseline.json in the same PR.
// Counting is caller-honest per the issue's correction: only real public
// method declarations count — moving an operation behind a params object,
// aggregate getter, port, or facade does not reduce this number, and making
// a projection target private (writer-only transcript mutation, event-fed
// snapshot projection) does. Clones the checked-in-baseline + AST-scanning
// vitest pattern from hostAgentDeepImportRatchet.vitest.ts.

// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../support/repoScan';

const BASELINE_FILE = 'config/ratchets/store-public-surface-baseline.json';
const BASELINE_PATH = resolve(REPO_ROOT, BASELINE_FILE);

const STORES = {
  StreamLogStore: 'src/transcript/StreamLogStore.ts',
  StreamSnapshotStore: 'src/transcript/StreamSnapshotStore.ts',
} as const;

type StoreName = keyof typeof STORES;

interface SurfaceBaseline {
  semantics: string;
  stores: Record<StoreName, string[]>;
}

function isPublicMethod(
  member: ts.ClassElement,
): member is ts.MethodDeclaration {
  if (!ts.isMethodDeclaration(member)) return false;
  const modifiers = ts.getModifiers(member) ?? [];
  // `protected` counts as public: neither store is subclassed, so a
  // `protected` mutator would stay exactly as reachable as a public one
  // while silently escaping a private-only count.
  return !modifiers.some(
    (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
  );
}

/** Public (static + instance) method names of one store class, sorted. */
function publicMethodNames(store: StoreName): string[] {
  const file = resolve(REPO_ROOT, STORES[store]);
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === store) {
      for (const member of node.members) {
        if (isPublicMethod(member) && ts.isIdentifier(member.name)) {
          names.push(member.name.text);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
}

function readBaseline(): SurfaceBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as SurfaceBaseline;
}

function reportGrowth(
  store: StoreName,
  baseline: string[],
  current: string[],
): string {
  const baselineSet = new Set(baseline);
  const added = current.filter((name) => !baselineSet.has(name));
  return (
    `${store} public methods grew from ${baseline.length} to ${current.length}:\n` +
    added.map((name) => `  + ${name}`).join('\n') +
    `\n\nEvery public store method is a caller-verified operation (#9590). ` +
    `If this growth is a deliberate new operation, update ${BASELINE_FILE} ` +
    `in this PR; when you reduce the surface further, lower the baseline ` +
    `to the new count instead.`
  );
}

describe('#9590 store public-surface budget ratchet', () => {
  const baseline = readBaseline();

  it.each(Object.keys(STORES) as StoreName[])(
    'does not increase the public method count of %s',
    (store) => {
      const current = publicMethodNames(store);
      expect(
        current.length,
        reportGrowth(store, baseline.stores[store], current),
      ).toBeLessThanOrEqual(baseline.stores[store].length);
    },
  );

  it('keeps the baseline ordered and duplicate-free per store', () => {
    for (const store of Object.keys(STORES) as StoreName[]) {
      const sortedUnique = [...new Set(baseline.stores[store])].toSorted(
        (a, b) => a.localeCompare(b),
      );
      expect(
        baseline.stores[store],
        `${BASELINE_FILE} stores.${store}`,
      ).toEqual(sortedUnique);
    }
  });
});
