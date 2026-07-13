// Node imports
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
  reason: 'new-edge' | 'value-escalation';
  baselineKind?: EdgeKind;
  currentKind: EdgeKind;
}

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const BASELINE_PATH = resolve(
  REPO_ROOT,
  'config/ratchets/architecture-edges-baseline.json',
);

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;

const SUBSYSTEM_ALIASES = new Map<string, string>([
  ['@agent', 'agent'],
  ['@auth', 'auth'],
  // tsconfig.json carves these two @common/* aliases out to
  // packages/extension/src/common/* (VS Code-coupled Memento/webview-base
  // modules), not src/common/*. Map them to distinct pseudo-subsystems so a
  // future src/-side import of either produces a genuine new-edge ratchet
  // failure instead of being silently absorbed into the `common` baseline.
  ['@common/state', 'common-state-extension'],
  ['@common/webview', 'common-webview-extension'],
  ['@common', 'common'],
  ['@controllers', 'controllers'],
  ['@eventBus', 'eventBus'],
  ['@hosts', 'hosts'],
  ['@housekeeping', 'housekeeping'],
  ['@latex', 'latex'],
  ['@logger', 'logger'],
  ['@model', 'model'],
  ['@platform', 'platform'],
  ['@replacement', 'replacement'],
  ['@shared', 'shared'],
  ['@skills', 'skills'],
  ['@telemetry', 'telemetry'],
  ['@tools', 'tools'],
  ['@transcript', 'transcript'],
  ['@types', 'types'],
  ['@utils', 'utils'],
]);

function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/');
}

function subsystemFromRepoRelative(path: string): string | null {
  const [root, subsystem] = path.split('/');
  if (root !== 'src' || subsystem == null || subsystem === 'test-kernel') {
    return null;
  }
  return subsystem;
}

function sourceFilesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((entry) => SOURCE_FILE.test(entry) && !entry.endsWith('.d.ts'))
    .map((entry) => join(dir, entry));
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
  // `@common/state` wins over the broader `@common` alias regardless of
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
  if (
    ts.isExternalModuleReference(ref) &&
    ref.expression != null &&
    ts.isStringLiteralLike(ref.expression)
  ) {
    return ref.expression.text;
  }
  return null;
}

function importTypeSpecifier(node: ts.ImportTypeNode): string | null {
  const { argument } = node;
  if (
    ts.isLiteralTypeNode(argument) &&
    ts.isStringLiteralLike(argument.literal)
  ) {
    return argument.literal.text;
  }
  return null;
}

function callExpressionSpecifier(node: ts.CallExpression): string | null {
  const [argument] = node.arguments;
  if (
    node.arguments.length !== 1 ||
    argument == null ||
    !ts.isStringLiteralLike(argument)
  ) {
    return null;
  }
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return argument.text;
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
    return argument.text;
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

  const key = `${from}->${to}`;
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
    if (ts.isImportDeclaration(node)) {
      addEdge(
        edges,
        from,
        resolveImportedSubsystem(
          file,
          stringLiteralText(node.moduleSpecifier) ?? '',
        ),
        importDeclarationKind(node),
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier != null) {
      addEdge(
        edges,
        from,
        resolveImportedSubsystem(
          file,
          stringLiteralText(node.moduleSpecifier) ?? '',
        ),
        exportDeclarationKind(node),
      );
    } else if (ts.isImportEqualsDeclaration(node)) {
      addEdge(
        edges,
        from,
        resolveImportedSubsystem(file, importEqualsSpecifier(node) ?? ''),
        node.isTypeOnly ? 'type-only' : 'value',
      );
    } else if (ts.isImportTypeNode(node)) {
      addEdge(
        edges,
        from,
        resolveImportedSubsystem(file, importTypeSpecifier(node) ?? ''),
        'type-only',
      );
    } else if (ts.isCallExpression(node)) {
      addEdge(
        edges,
        from,
        resolveImportedSubsystem(file, callExpressionSpecifier(node) ?? ''),
        'value',
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function collectSubsystemEdges(): SubsystemEdge[] {
  const edges = new Map<string, EdgeKind>();

  for (const file of sourceFilesUnder(SRC_ROOT)) {
    const from = subsystemFromRepoRelative(repoRelative(file));
    if (from == null) {
      continue;
    }

    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    visitImports(sourceFile, file, from, edges);
  }

  return [...edges.entries()]
    .map(([key, kind]) => {
      const [from, to] = key.split('->');
      if (from == null || to == null) {
        throw new Error(`Malformed subsystem edge key: ${key}`);
      }
      return { from, to, kind };
    })
    .toSorted(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.kind.localeCompare(b.kind),
    );
}

function readBaseline(): EdgeBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as EdgeBaseline;
}

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
      violations.push({
        edge: edgeKey(edge),
        reason: 'new-edge',
        currentKind: edge.kind,
      });
      continue;
    }
    if (baselineEdge.kind === 'type-only' && edge.kind === 'value') {
      violations.push({
        edge: edgeKey(edge),
        reason: 'value-escalation',
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

  it('keeps the baseline non-empty and ordered', () => {
    const baseline = readBaseline();
    const sortedEdges = baseline.edges.toSorted(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.kind.localeCompare(b.kind),
    );

    expect(baseline.edges.length).toBeGreaterThan(90);
    expect(baseline.edges).toEqual(sortedEdges);
  });

  it('does not bucket @common/state or @common/webview imports into the already-whitelisted common edge', () => {
    // tsconfig.json carves these two aliases out to
    // packages/extension/src/common/* (VS Code-coupled), not src/common/*.
    // A src/-side import of either must not resolve to the generic `common`
    // subsystem, because `agent -> common` (etc.) is already whitelisted in
    // the baseline and would silently absorb the violating import.
    const file = join(SRC_ROOT, 'agent', 'example.ts');
    const stateSubsystem = resolveImportedSubsystem(file, '@common/state');
    const webviewSubsystem = resolveImportedSubsystem(file, '@common/webview');

    expect(stateSubsystem).not.toBe('common');
    expect(webviewSubsystem).not.toBe('common');
    expect(resolveImportedSubsystem(file, '@common/state/foo')).toBe(
      stateSubsystem,
    );
    expect(resolveImportedSubsystem(file, '@common/webview/foo')).toBe(
      webviewSubsystem,
    );
    // The generic `@common` alias (src/common/*) is unaffected.
    expect(resolveImportedSubsystem(file, '@common/foo')).toBe('common');

    // A hypothetical future `agent -> @common/state` import must surface as
    // a genuine new-edge ratchet violation, not be silently absorbed.
    const violations = findRatchetViolations(
      [{ from: 'agent', to: stateSubsystem ?? '', kind: 'value' }],
      readBaseline().edges,
    );
    expect(violations).toEqual([
      {
        edge: `agent->${stateSubsystem}`,
        reason: 'new-edge',
        currentKind: 'value',
      },
    ]);
  });
});
