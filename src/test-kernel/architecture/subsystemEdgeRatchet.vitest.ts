// Node imports
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Third-party imports
import { format, resolveConfig } from 'prettier';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  parseSourceFile,
  REPO_ROOT,
  sourceFilesUnder,
  toRepoPath as repoRelative,
} from '../support/repoScan';

type EdgeKind = 'type-only' | 'value';

interface SubsystemEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

interface EdgeBaseline {
  semantics: string;
  edges: SubsystemEdge[];
}

interface EdgeViolation {
  edge: string;
  reason: 'new-edge' | 'value-escalation' | 'value-overstated';
  baselineKind?: EdgeKind;
  currentKind: EdgeKind;
}

const SRC_ROOT = resolve(REPO_ROOT, 'src');
const BASELINE_PATH = resolve(
  REPO_ROOT,
  'config/ratchets/architecture-edges-baseline.json',
);

const TSCONFIG_PATH = resolve(REPO_ROOT, 'tsconfig.json');

/**
 * The roots a subsystem directory sits under: `src/` before the package
 * split, and the harness and app packages after it. A
 * subsystem keeps its name across the move (`packages/harness/src/tools/x` and
 * `packages/texra/src/tools/y` are both `tools`), so the baseline is keyed
 * the same on either side of it.
 */
const SUBSYSTEM_ROOTS = [
  'src/',
  'packages/harness/src/',
  'packages/texra/src/',
];

/** Each tsconfig alias (`@tools`, `@transcript`) and the path it names. */
function loadAliasTargets(): Map<string, string> {
  const parsed = ts.parseConfigFileTextToJson(
    TSCONFIG_PATH,
    readFileSync(TSCONFIG_PATH, 'utf8'),
  );
  if (parsed.error != null) {
    throw new Error(`Cannot parse tsconfig.json: ${parsed.error.messageText}`);
  }

  const paths = parsed.config?.compilerOptions?.paths as
    Record<string, string[]> | undefined;
  const aliases = new Map<string, string>();

  for (const [key, values] of Object.entries(paths ?? {})) {
    const alias = key.replace(/\/\*$/, '');
    // The harness's package entries are its public surface, not a subsystem:
    // an import through them is no edge between top-level directories.
    if (!alias.startsWith('@') || alias.startsWith('@texra-ai/')) continue;
    const target = values[0]
      ?.replace(/\/\*$/, '')
      .replace(/^\.\//, '')
      .replace(/\/index\.ts$/, '');
    if (target != null) aliases.set(alias, target);
  }

  return aliases;
}

const ALIAS_TARGETS = loadAliasTargets();

/** The directories an alias names under a subsystem root: the subsystems. */
const SUBSYSTEMS = new Set(
  [...ALIAS_TARGETS.values()].flatMap((target) => {
    const name = subsystemPath(target);
    return name == null ? [] : [name.split('/')[0]];
  }),
);

/** The path under its subsystem root, or null outside every root. */
function subsystemPath(path: string): string | null {
  const root = SUBSYSTEM_ROOTS.find((prefix) => path.startsWith(prefix));
  return root == null ? null : path.slice(root.length);
}

function subsystemFromRepoRelative(path: string): string | null {
  // These extension-owned aliases deliberately overlap @common. Keep them
  // in distinct pseudo-subsystems so they cannot hide in a common edge.
  const extensionCommon = /^packages\/extension\/src\/common\/([^/]+)/.exec(
    path,
  );
  if (extensionCommon?.[1] != null) {
    return `common-${extensionCommon[1]}-extension`;
  }
  const subsystem = subsystemPath(path)?.split('/')[0];
  if (subsystem == null || subsystem === 'test-kernel') return null;
  return SUBSYSTEMS.has(subsystem) ? subsystem : null;
}

/** The repo path an import names, or null for a package outside the aliases. */
function resolveImportPath(file: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    return repoRelative(resolve(dirname(file), specifier));
  }

  // Match the most specific (longest) alias so a carve-out like
  // `@common/webview` wins over the broader `@common` alias regardless of
  // map insertion order.
  let bestMatch: { alias: string; target: string } | null = null;
  for (const [alias, target] of ALIAS_TARGETS) {
    if (
      (specifier === alias || specifier.startsWith(`${alias}/`)) &&
      (bestMatch == null || alias.length > bestMatch.alias.length)
    ) {
      bestMatch = { alias, target };
    }
  }
  return bestMatch == null
    ? null
    : `${bestMatch.target}${specifier.slice(bestMatch.alias.length)}`;
}

function resolveImportedSubsystem(
  file: string,
  specifier: string,
): string | null {
  const path = resolveImportPath(file, specifier);
  return path == null ? null : subsystemFromRepoRelative(path);
}

function stringLiteralText(node: ts.Node): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function namedImportsAreTypeOnly(bindings: ts.NamedImportBindings): boolean {
  return (
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function importDeclarationKind(node: ts.ImportDeclaration): EdgeKind {
  if (node.importClause == null) {
    return 'value';
  }
  if (node.importClause.isTypeOnly) {
    return 'type-only';
  }
  if (node.importClause.name != null) {
    return 'value';
  }

  const { namedBindings } = node.importClause;
  return namedBindings != null && namedImportsAreTypeOnly(namedBindings)
    ? 'type-only'
    : 'value';
}

function exportDeclarationKind(node: ts.ExportDeclaration): EdgeKind {
  if (node.isTypeOnly) {
    return 'type-only';
  }

  const { exportClause } = node;
  return exportClause != null &&
    ts.isNamedExports(exportClause) &&
    exportClause.elements.length > 0 &&
    exportClause.elements.every((element) => element.isTypeOnly)
    ? 'type-only'
    : 'value';
}

function importEqualsSpecifier(
  node: ts.ImportEqualsDeclaration,
): string | null {
  const ref = node.moduleReference;
  return ts.isExternalModuleReference(ref)
    ? stringLiteralText(ref.expression)
    : null;
}

function importTypeSpecifier(node: ts.ImportTypeNode): string | null {
  const { argument } = node;
  return ts.isLiteralTypeNode(argument)
    ? stringLiteralText(argument.literal)
    : null;
}

function callExpressionSpecifier(node: ts.CallExpression): string | null {
  const [argument] = node.arguments;
  if (node.arguments.length !== 1 || argument == null) {
    return null;
  }
  const loadsModule =
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require');
  return loadsModule ? stringLiteralText(argument) : null;
}

/** The module a node loads, together with the edge kind it implies. */
function moduleReference(
  node: ts.Node,
): { specifier: string | null; kind: EdgeKind } | null {
  if (ts.isImportDeclaration(node)) {
    return {
      specifier: stringLiteralText(node.moduleSpecifier),
      kind: importDeclarationKind(node),
    };
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier != null) {
    return {
      specifier: stringLiteralText(node.moduleSpecifier),
      kind: exportDeclarationKind(node),
    };
  }
  if (ts.isImportEqualsDeclaration(node)) {
    return {
      specifier: importEqualsSpecifier(node),
      kind: node.isTypeOnly ? 'type-only' : 'value',
    };
  }
  if (ts.isImportTypeNode(node)) {
    return { specifier: importTypeSpecifier(node), kind: 'type-only' };
  }
  if (ts.isCallExpression(node)) {
    return { specifier: callExpressionSpecifier(node), kind: 'value' };
  }
  return null;
}

function addEdge(
  edges: Map<string, EdgeKind>,
  from: string,
  to: string | null,
  kind: EdgeKind,
): void {
  if (to == null || to === from) {
    return;
  }

  const key = edgeKey({ from, to });
  const previous = edges.get(key);
  edges.set(
    key,
    previous === 'value' || kind === 'value' ? 'value' : 'type-only',
  );
}

/** Calls `onImport` with each module a file loads and the kind it implies. */
function visitImports(
  sourceFile: ts.SourceFile,
  onImport: (specifier: string, kind: EdgeKind) => void,
): void {
  const visit = (node: ts.Node): void => {
    const reference = moduleReference(node);
    if (reference?.specifier != null) {
      onImport(reference.specifier, reference.kind);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function compareEdges(a: SubsystemEdge, b: SubsystemEdge): number {
  return (
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.kind.localeCompare(b.kind)
  );
}

function collectSubsystemEdges(): SubsystemEdge[] {
  const edges = new Map<string, EdgeKind>();

  const files = SUBSYSTEM_ROOTS.flatMap((root) =>
    sourceFilesUnder(resolve(REPO_ROOT, root), {}),
  );
  for (const file of files) {
    const from = subsystemFromRepoRelative(repoRelative(file));
    if (from == null) {
      continue;
    }

    visitImports(
      parseSourceFile(file, { setParentNodes: false }),
      (specifier, kind) =>
        addEdge(edges, from, resolveImportedSubsystem(file, specifier), kind),
    );
  }

  return edgeList(edges);
}

function edgeList(edges: Map<string, EdgeKind>): SubsystemEdge[] {
  return [...edges.entries()]
    .map(([key, kind]) => {
      const [from, to] = key.split('->');
      if (from == null || to == null) {
        throw new Error(`Malformed subsystem edge key: ${key}`);
      }
      return { from, to, kind };
    })
    .toSorted(compareEdges);
}

const HARNESS_SRC = 'packages/harness/src/';

/** A harness file's top-level directory; the package entries at its root are `entries`. */
function harnessDirectory(path: string): string | null {
  if (!path.startsWith(HARNESS_SRC)) return null;
  const parts = path.slice(HARNESS_SRC.length).split('/');
  return parts.length > 1 ? (parts[0] ?? null) : 'entries';
}

/** Directed imports between the harness's top-level directories. */
function collectHarnessEdges(): SubsystemEdge[] {
  const edges = new Map<string, EdgeKind>();
  for (const file of sourceFilesUnder(resolve(REPO_ROOT, HARNESS_SRC))) {
    const from = harnessDirectory(repoRelative(file));
    if (from == null) continue;
    visitImports(
      parseSourceFile(file, { setParentNodes: false }),
      (specifier, kind) => {
        const path = resolveImportPath(file, specifier);
        addEdge(
          edges,
          from,
          path == null ? null : harnessDirectory(path),
          kind,
        );
      },
    );
  }
  return edgeList(edges);
}

const HARNESS_BASELINE_FILE =
  'config/ratchets/harness-layer-edges-baseline.json';
const HARNESS_BASELINE_PATH = resolve(REPO_ROOT, HARNESS_BASELINE_FILE);

/**
 * The harness's layer order, bottom first; packages/harness/AGENTS.md
 * "Layer order" says what sits where. An import points to a strictly lower
 * layer. Every other harness import (upward, within one layer, or either
 * half of a two-way directory pair) is listed in HARNESS_BASELINE_FILE,
 * which only shrinks.
 */
const HARNESS_LAYERS: readonly (readonly string[])[] = [
  ['logger'],
  ['utils'],
  ['shared'],
  ['common'],
  ['platform'],
  ['model', 'skills'],
  ['agent', 'tools', 'transcript'],
  ['controllers'],
  ['effect'],
  ['entries'],
];

function harnessLayer(directory: string): number {
  return HARNESS_LAYERS.findIndex((layer) => layer.includes(directory));
}

/** Why an import breaks the order, or null when it points down. */
function layerBreak(
  edge: SubsystemEdge,
  keys: ReadonlySet<string>,
): 'upward' | 'same layer' | 'two-way' | null {
  const from = harnessLayer(edge.from);
  const to = harnessLayer(edge.to);
  if (to > from) return 'upward';
  if (to === from) return 'same layer';
  return keys.has(edgeKey({ from: edge.to, to: edge.from })) ? 'two-way' : null;
}

/** The live harness imports that do not point strictly down. */
function harnessLayerBreaks(edges: SubsystemEdge[]): SubsystemEdge[] {
  const keys = new Set(edges.map(edgeKey));
  return edges.filter((edge) => layerBreak(edge, keys) != null);
}

function readHarnessBaseline(): EdgeBaseline {
  return JSON.parse(
    readFileSync(HARNESS_BASELINE_PATH, 'utf8'),
  ) as EdgeBaseline;
}

function readBaseline(): EdgeBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as EdgeBaseline;
}

/**
 * New edges admitted by name, each with its reason. The JSON baseline is
 * shrink-only, so a deliberate new edge is recorded here, the way
 * eslint.config.mjs names its Effect runtime entries. The
 * admission is for the type-only form only: a later value import still fails
 * as a new-edge violation of kind `value`. Adding an entry is a ruling, not a
 * refactor.
 */
const ADMITTED_TYPE_ONLY_EDGES = new Map<string, string>();

function edgeKey(edge: Pick<SubsystemEdge, 'from' | 'to'>): string {
  return `${edge.from}->${edge.to}`;
}

function findRatchetViolations(
  current: SubsystemEdge[],
  baseline: SubsystemEdge[],
  admitted: ReadonlyMap<string, string> = ADMITTED_TYPE_ONLY_EDGES,
): EdgeViolation[] {
  const baselineByEdge = new Map(baseline.map((edge) => [edgeKey(edge), edge]));
  const violations: EdgeViolation[] = [];

  for (const edge of current) {
    const baselineEdge = baselineByEdge.get(edgeKey(edge));
    if (baselineEdge == null) {
      if (edge.kind === 'type-only' && admitted.has(edgeKey(edge))) {
        continue;
      }
      violations.push({
        edge: edgeKey(edge),
        reason: 'new-edge',
        currentKind: edge.kind,
      });
      continue;
    }
    // A kind mismatch is a violation in BOTH directions, not just the widening
    // one. A row that over-states itself as `value` while every live import is
    // `type-only` is not itself a widening, but it is permanent headroom in the
    // one direction this ratchet does police: the baseline already claims
    // `value`, so a later type-only -> value escalation compares equal to it
    // and is silently allowed. Recording the live kind shrinks the baseline,
    // which is the direction it is allowed to move.
    if (baselineEdge.kind !== edge.kind) {
      violations.push({
        edge: edgeKey(edge),
        reason: edge.kind === 'value' ? 'value-escalation' : 'value-overstated',
        baselineKind: baselineEdge.kind,
        currentKind: edge.kind,
      });
    }
  }

  return violations;
}

function formatViolations(violations: EdgeViolation[]): string {
  return violations
    .map((violation) => {
      if (violation.reason === 'new-edge') {
        return `${violation.edge}: new ${violation.currentKind} edge`;
      }
      if (violation.reason === 'value-overstated') {
        return (
          `${violation.edge}: baseline records ${violation.baselineKind} but ` +
          `every live import is ${violation.currentKind}; record it as ` +
          `${violation.currentKind} so the row cannot absorb a later escalation`
        );
      }
      return `${violation.edge}: ${violation.baselineKind} baseline gained a ${violation.currentKind} import`;
    })
    .join('\n');
}

describe('LAY-1 subsystem edge ratchet', () => {
  it('does not introduce new top-level src subsystem edge types', () => {
    const baseline = readBaseline();
    const violations = findRatchetViolations(
      collectSubsystemEdges(),
      baseline.edges,
    );

    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('rejects baseline edges with no live site (stale headroom)', () => {
    const baseline = readBaseline();
    const currentKeys = new Set(collectSubsystemEdges().map(edgeKey));
    const stale = baseline.edges.filter(
      (edge) => !currentKeys.has(edgeKey(edge)),
    );

    expect(
      stale,
      `Stale subsystem edge(s) in ${BASELINE_PATH}:\n` +
        stale.map((edge) => `  - ${edgeKey(edge)} (${edge.kind})`).join('\n') +
        '\n\nRemove them from the baseline so they cannot absorb a future new edge.',
    ).toEqual([]);
  });

  it('rejects a baseline value row whose live import is type-only (value-overstated)', () => {
    const baseline = readBaseline();
    const valueRow = baseline.edges.find((edge) => edge.kind === 'value');
    if (valueRow == null) {
      throw new Error(
        `${BASELINE_PATH} has no value row to exercise the mirror arm against.`,
      );
    }

    // Deriving the row from the baseline keeps this assertion honest as the
    // baseline shrinks: it exercises the mirror arm on whatever value row the
    // ratchet currently claims, rather than on a hardcoded pair.
    const violations = findRatchetViolations(
      [{ ...valueRow, kind: 'type-only' }],
      baseline.edges,
    );

    expect(violations).toEqual([
      {
        edge: edgeKey(valueRow),
        reason: 'value-overstated',
        baselineKind: 'value',
        currentKind: 'type-only',
      },
    ]);
    expect(formatViolations(violations)).toContain(
      'every live import is type-only',
    );
  });

  it('keeps the baseline non-empty and ordered', () => {
    const baseline = readBaseline();
    const sortedEdges = baseline.edges.toSorted(compareEdges);

    expect(baseline.edges.length).toBeGreaterThan(0);
    expect(baseline.edges).toEqual(sortedEdges);
  });

  it('does not bucket @common/webview imports into the already-whitelisted common edge', () => {
    // tsconfig.json carves this alias out to
    // packages/extension/src/common/webview (VS Code-coupled), not packages/harness/src/common/*.
    // A src/-side import of it must not resolve to the generic `common`
    // subsystem, because `agent -> common` (etc.) is already whitelisted in
    // the baseline and would silently absorb the violating import.
    const file = join(SRC_ROOT, 'agent', 'example.ts');
    const webviewSubsystem = resolveImportedSubsystem(file, '@common/webview');

    expect(webviewSubsystem).not.toBe('common');
    expect(resolveImportedSubsystem(file, '@common/webview/foo')).toBe(
      webviewSubsystem,
    );
    // The generic `@common` alias (packages/harness/src/common/*) is unaffected.
    expect(resolveImportedSubsystem(file, '@common/foo')).toBe('common');

    // A hypothetical future `agent -> @common/webview` import must surface as
    // a genuine new-edge ratchet violation, not be silently absorbed.
    const violations = findRatchetViolations(
      [{ from: 'agent', to: webviewSubsystem ?? '', kind: 'value' }],
      readBaseline().edges,
    );
    expect(violations).toEqual([
      {
        edge: `agent->${webviewSubsystem}`,
        reason: 'new-edge',
        currentKind: 'value',
      },
    ]);
  });
});

describe('LAY-2 harness layer order', () => {
  const edges = collectHarnessEdges();
  const keys = new Set(edges.map(edgeKey));
  const baseline = readHarnessBaseline();

  it('places every harness directory in a layer', () => {
    const unplaced = [...new Set(edges.flatMap(({ from, to }) => [from, to]))]
      .filter((directory) => harnessLayer(directory) < 0)
      .toSorted();

    expect(
      unplaced,
      'add each new packages/harness/src directory to HARNESS_LAYERS and to the order in packages/harness/AGENTS.md',
    ).toEqual([]);
  });

  it('adds no upward, same-layer or two-way import', () => {
    const violations = findRatchetViolations(
      harnessLayerBreaks(edges),
      baseline.edges,
      new Map(),
    ).filter((violation) => violation.reason !== 'value-overstated');
    const lines = violations.map((violation) => {
      const [from = '', to = ''] = violation.edge.split('->');
      const why = layerBreak({ from, to, kind: violation.currentKind }, keys);
      return `${formatViolations([violation])} (${why})`;
    });

    expect(
      lines,
      `harness imports point down HARNESS_LAYERS; move the code to the layer that owns it instead. Do not widen ${HARNESS_BASELINE_FILE}.`,
    ).toEqual([]);
  });

  it('counts a downward import as a break when its reverse exists', () => {
    const up = {
      from: 'shared',
      to: 'controllers',
      kind: 'type-only' as const,
    };
    const down = { from: 'controllers', to: 'shared', kind: 'value' as const };

    expect(harnessLayerBreaks([down])).toEqual([]);
    expect(harnessLayerBreaks([up, down])).toEqual([up, down]);
  });

  it('lists only imports that still break the order', async () => {
    const live = new Map(harnessLayerBreaks(edges).map((e) => [edgeKey(e), e]));
    const kept = baseline.edges.flatMap((edge) => {
      const current = live.get(edgeKey(edge));
      return current == null
        ? []
        : [{ ...edge, kind: edge.kind === 'value' ? current.kind : edge.kind }];
    });
    const rows = kept.map((edge) => `    ${JSON.stringify(edge)}`).join(',\n');
    const text = await format(
      `{"semantics": ${JSON.stringify(baseline.semantics)}, "edges": [\n${rows}\n]}`,
      {
        ...(await resolveConfig(HARNESS_BASELINE_PATH)),
        filepath: HARNESS_BASELINE_PATH,
      },
    );

    await expect(text).toMatchFileSnapshot(
      HARNESS_BASELINE_PATH,
      `a listed import now points down, is type-only, or is gone: run \`npx vitest run src/test-kernel/architecture/subsystemEdgeRatchet.vitest.ts -u\` to shrink ${HARNESS_BASELINE_FILE}`,
    );
  });
});
