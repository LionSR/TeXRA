// Node imports
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Third-party imports
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

function loadSubsystemAliases(): Map<string, string> {
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
    if (!alias.startsWith('@')) continue;

    const target = values[0]
      ?.replace(/\/\*$/, '')
      .replace(/^\.\//, '')
      .replace(/\/index\.ts$/, '');
    if (target == null) continue;

    const subsystem = subsystemFromRepoRelative(target);
    if (subsystem != null) {
      aliases.set(alias, subsystem);
      continue;
    }

    // These extension-owned aliases deliberately overlap @common. Keep them
    // in distinct pseudo-subsystems so they cannot hide in a common edge.
    const extensionCommon = /^packages\/extension\/src\/common\/([^/]+)$/.exec(
      target,
    );
    if (extensionCommon?.[1] != null) {
      aliases.set(alias, `common-${extensionCommon[1]}-extension`);
    }
  }

  return aliases;
}

const SUBSYSTEM_ALIASES = loadSubsystemAliases();

function subsystemFromRepoRelative(path: string): string | null {
  const [root, subsystem] = path.split('/');
  if (root !== 'src' || subsystem == null || subsystem === 'test-kernel') {
    return null;
  }
  return subsystem;
}

function resolveImportedSubsystem(
  file: string,
  specifier: string,
): string | null {
  if (specifier.startsWith('.')) {
    return subsystemFromRepoRelative(
      repoRelative(resolve(dirname(file), specifier)),
    );
  }

  // Match the most specific (longest) alias so a carve-out like
  // `@common/webview` wins over the broader `@common` alias regardless of
  // map insertion order.
  let bestMatch: { alias: string; subsystem: string } | null = null;
  for (const [alias, subsystem] of SUBSYSTEM_ALIASES) {
    if (
      (specifier === alias || specifier.startsWith(`${alias}/`)) &&
      (bestMatch == null || alias.length > bestMatch.alias.length)
    ) {
      bestMatch = { alias, subsystem };
    }
  }

  return bestMatch?.subsystem ?? null;
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

function visitImports(
  sourceFile: ts.SourceFile,
  file: string,
  from: string,
  edges: Map<string, EdgeKind>,
): void {
  const visit = (node: ts.Node): void => {
    const reference = moduleReference(node);
    if (reference?.specifier != null) {
      addEdge(
        edges,
        from,
        resolveImportedSubsystem(file, reference.specifier),
        reference.kind,
      );
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

  for (const file of sourceFilesUnder(SRC_ROOT)) {
    const from = subsystemFromRepoRelative(repoRelative(file));
    if (from == null) {
      continue;
    }

    visitImports(
      parseSourceFile(file, { setParentNodes: false }),
      file,
      from,
      edges,
    );
  }

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

function readBaseline(): EdgeBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as EdgeBaseline;
}

/**
 * New edges admitted by name, each with its reason. The JSON baseline is
 * shrink-only, so a deliberate new edge is recorded here, the way
 * `check-effect-migration-ratchet.mjs` records BOUNDARY_RUNTIME_ENTRIES. The
 * admission is for the type-only form only: a later value import still fails
 * as a new-edge violation of kind `value`. Adding an entry is a ruling, not a
 * refactor.
 */
const ADMITTED_TYPE_ONLY_EDGES = new Map<string, string>([
  [
    'platform->auth',
    'processRuntime.ts unions the `SupabaseAuth` tag into `ProcessServices` ' +
      'beside the existing `@agent`/`@tools` service tags: the account plane ' +
      'is a process-lifetime service every host root installs once.',
  ],
]);

function edgeKey(edge: Pick<SubsystemEdge, 'from' | 'to'>): string {
  return `${edge.from}->${edge.to}`;
}

function findRatchetViolations(
  current: SubsystemEdge[],
  baseline: SubsystemEdge[],
): EdgeViolation[] {
  const baselineByEdge = new Map(baseline.map((edge) => [edgeKey(edge), edge]));
  const violations: EdgeViolation[] = [];

  for (const edge of current) {
    const baselineEdge = baselineByEdge.get(edgeKey(edge));
    if (baselineEdge == null) {
      if (
        edge.kind === 'type-only' &&
        ADMITTED_TYPE_ONLY_EDGES.has(edgeKey(edge))
      ) {
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

    expect(baseline.edges.length).toBeGreaterThan(80);
    expect(baseline.edges).toEqual(sortedEdges);
  });

  it('does not bucket @common/webview imports into the already-whitelisted common edge', () => {
    // tsconfig.json carves this alias out to
    // packages/extension/src/common/webview (VS Code-coupled), not src/common/*.
    // A src/-side import of it must not resolve to the generic `common`
    // subsystem, because `agent -> common` (etc.) is already whitelisted in
    // the baseline and would silently absorb the violating import.
    const file = join(SRC_ROOT, 'agent', 'example.ts');
    const webviewSubsystem = resolveImportedSubsystem(file, '@common/webview');

    expect(webviewSubsystem).not.toBe('common');
    expect(resolveImportedSubsystem(file, '@common/webview/foo')).toBe(
      webviewSubsystem,
    );
    // The generic `@common` alias (src/common/*) is unaffected.
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
