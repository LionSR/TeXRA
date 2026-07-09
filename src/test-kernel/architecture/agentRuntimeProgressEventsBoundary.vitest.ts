// Node imports
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

const LEGACY_MODULE = 'src/agent/runtime/hostProgressEvents.ts';
const OLD_AGENT_RUNTIME_MODULE =
  'src/agent/runtime/agentRuntimeProgressEvents.ts';
const CLI_MODULE = 'packages/cli/src/runtime/cliProgressEvents.ts';
const OLD_AGENT_RUNTIME_ALIAS = '@agent/runtime/agentRuntimeProgressEvents';
const CLI_ALIAS = '@cli/runtime/cliProgressEvents';

const ALLOWED_PRODUCTION_IMPORTERS = [
  'packages/cli/src/runtime/runtimeHost.ts',
  'packages/cli/src/runtime/sessionProgressSubscription.ts',
] as const;

const SCAN_ROOTS = [
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const;

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;
const SOURCE_OR_OUTPUT_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function toRepoPath(path: string): string {
  return relative(REPO_ROOT, resolve(REPO_ROOT, path)).replaceAll('\\', '/');
}

function sourceFilesUnder(root: string): string[] {
  const absoluteRoot = resolve(REPO_ROOT, root);
  let entries: string[];
  try {
    entries = readdirSync(absoluteRoot, { recursive: true }) as string[];
  } catch {
    return [];
  }

  return entries
    .filter((entry) => SOURCE_FILE.test(entry) && !entry.endsWith('.d.ts'))
    .map((entry) => toRepoPath(join(absoluteRoot, entry)))
    .filter((file) => !file.startsWith('src/test-kernel/'));
}

function literalText(node: ts.Expression | undefined): string | null {
  return node != null && ts.isStringLiteralLike(node) ? node.text : null;
}

function moduleSpecifierFromImportEquals(
  node: ts.ImportEqualsDeclaration,
): string | null {
  const reference = node.moduleReference;
  if (!ts.isExternalModuleReference(reference)) return null;
  return literalText(reference.expression);
}

function moduleSpecifierFromCall(node: ts.CallExpression): string | null {
  const [firstArg] = node.arguments;
  if (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  ) {
    return literalText(firstArg);
  }
  return null;
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier != null) specifiers.push(specifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const specifier = moduleSpecifierFromImportEquals(node);
      if (specifier != null) specifiers.push(specifier);
    } else if (ts.isCallExpression(node)) {
      const specifier = moduleSpecifierFromCall(node);
      if (specifier != null) specifiers.push(specifier);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function resolveAgentAlias(specifier: string): string | null {
  if (specifier === OLD_AGENT_RUNTIME_ALIAS) return OLD_AGENT_RUNTIME_MODULE;
  if (!specifier.startsWith('@agent/')) return null;
  return `src/agent/${specifier.slice('@agent/'.length)}`;
}

function resolveCliAlias(specifier: string): string | null {
  if (specifier === CLI_ALIAS) return CLI_MODULE;
  if (!specifier.startsWith('@cli/')) return null;
  return `packages/cli/src/${specifier.slice('@cli/'.length)}`;
}

function resolveRepoRelativeImport(
  importer: string,
  specifier: string,
): string | null {
  if (specifier.startsWith('@agent/')) return resolveAgentAlias(specifier);
  if (specifier.startsWith('@cli/')) return resolveCliAlias(specifier);
  if (!specifier.startsWith('.')) return null;
  return toRepoPath(join(dirname(importer), specifier));
}

function resolvesToModule(
  importer: string,
  specifier: string,
  targetModule: string,
): boolean {
  const resolved = resolveRepoRelativeImport(importer, specifier);
  if (resolved == null) return false;

  if (resolved === targetModule) return true;

  const targetModuleStem = targetModule.replace(/\.(?:ts|tsx|mts|cts)$/, '');
  const resolvedStem = resolved.replace(SOURCE_OR_OUTPUT_EXTENSION, '');
  return resolvedStem === targetModuleStem;
}

function importsModule(file: string, targetModule: string): boolean {
  const sourceText = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  return collectModuleSpecifiers(sourceFile).some((specifier) =>
    resolvesToModule(file, specifier, targetModule),
  );
}

describe('agent runtime progress-event vocabulary boundary', () => {
  it('deletes the legacy hostProgressEvents module', () => {
    expect(existsSync(resolve(REPO_ROOT, LEGACY_MODULE))).toBe(false);
  });

  it('removes the agent-runtime CLI progress vocabulary module', () => {
    expect(existsSync(resolve(REPO_ROOT, OLD_AGENT_RUNTIME_MODULE))).toBe(
      false,
    );

    const importers = SCAN_ROOTS.flatMap(sourceFilesUnder)
      .filter((file) => importsModule(file, OLD_AGENT_RUNTIME_MODULE))
      .toSorted();

    expect(importers).toEqual([]);
  });

  it('keeps the CLI progress vocabulary scoped to the CLI package', () => {
    expect(existsSync(resolve(REPO_ROOT, CLI_MODULE))).toBe(true);

    const importers = SCAN_ROOTS.flatMap(sourceFilesUnder)
      .filter((file) => importsModule(file, CLI_MODULE))
      .toSorted();

    expect(importers).toEqual([...ALLOWED_PRODUCTION_IMPORTERS].toSorted());
  });

  it('actually scans the production source roots', () => {
    const scanned = SCAN_ROOTS.reduce(
      (total, root) => total + sourceFilesUnder(root).length,
      0,
    );
    expect(scanned).toBeGreaterThan(100);
  });
});
