// #9590 Stage 5 store public-surface budget ratchet (proof obligation 10).
// The two transcript stores' public method counts are pinned by a checked-in
// baseline: equal is allowed, growth fails, and a genuine reduction should
// shrink config/ratchets/store-public-surface-baseline.json in the same PR.
// Counting is caller-honest per the issue's correction: each public method is
// one contract unit, while every field exposed by a configured aggregate
// snapshot getter is one unit. Replacing five getters with getRunMetadata thus
// keeps five caller-visible units instead of gaming the method count down to
// one. Making a projection target private (writer-only transcript mutation,
// event-fed snapshot projection) genuinely reduces reachability.
// Clones the checked-in-baseline + AST-scanning
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
  aggregateContracts: Partial<Record<StoreName, Record<string, string[]>>>;
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

function storeSourceFile(store: StoreName): ts.SourceFile {
  const file = resolve(REPO_ROOT, STORES[store]);
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

/** Public (static + instance) method names of one store class, sorted. */
function publicMethodNames(store: StoreName): string[] {
  const sourceFile = storeSourceFile(store);
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

function aggregateFieldNames(store: StoreName, methodName: string): string[] {
  const sourceFile = storeSourceFile(store);
  let returnTypeName: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === store) {
      const method = node.members.find(
        (member): member is ts.MethodDeclaration =>
          isPublicMethod(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === methodName,
      );
      if (method?.type && ts.isTypeReferenceNode(method.type)) {
        const { typeName } = method.type;
        if (ts.isIdentifier(typeName)) returnTypeName = typeName.text;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!returnTypeName) return [];

  const declaration = sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === returnTypeName,
  );
  if (!declaration) return [];
  return declaration.members
    .filter(
      (member): member is ts.PropertySignature & { name: ts.Identifier } =>
        ts.isPropertySignature(member) && ts.isIdentifier(member.name),
    )
    .map((member) => member.name.text)
    .toSorted((a, b) => a.localeCompare(b));
}

function contractUnits(
  methods: readonly string[],
  aggregates: Record<string, string[]> | undefined,
): number {
  return (
    methods.length +
    Object.values(aggregates ?? {}).reduce(
      (extra, fields) => extra + Math.max(0, fields.length - 1),
      0,
    )
  );
}

function readBaseline(): SurfaceBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as SurfaceBaseline;
}

function reportGrowth(
  store: StoreName,
  baseline: number,
  current: number,
): string {
  return (
    `${store} caller-visible contract units grew from ${baseline} to ${current}.` +
    `\n\nEach public method counts once, and each field in a configured ` +
    `aggregate snapshot contract counts once. If this growth is deliberate, ` +
    `update ${BASELINE_FILE} in this PR; when the surface truly shrinks, ` +
    `lower the baseline instead.`
  );
}

describe('#9590 store public-surface budget ratchet', () => {
  const baseline = readBaseline();

  it.each(Object.keys(STORES) as StoreName[])(
    'does not increase the caller-visible contract budget of %s',
    (store) => {
      const currentMethods = publicMethodNames(store);
      const aggregateContracts = baseline.aggregateContracts[store];
      const baselineUnits = contractUnits(
        baseline.stores[store],
        aggregateContracts,
      );
      const currentUnits = contractUnits(currentMethods, aggregateContracts);
      expect(
        currentUnits,
        reportGrowth(store, baselineUnits, currentUnits),
      ).toBeLessThanOrEqual(baselineUnits);
    },
  );

  it('pins every configured aggregate snapshot contract', () => {
    for (const store of Object.keys(
      baseline.aggregateContracts,
    ) as StoreName[]) {
      for (const [method, fields] of Object.entries(
        baseline.aggregateContracts[store] ?? {},
      )) {
        expect(
          aggregateFieldNames(store, method),
          `${store}.${method} aggregate fields`,
        ).toEqual(fields);
      }
    }
  });

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
