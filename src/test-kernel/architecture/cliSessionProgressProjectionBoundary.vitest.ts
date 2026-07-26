// Node imports
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Third-party imports
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, sourceFilesUnder, toRepoPath } from '../support/repoScan';

const TARGET_MODULE = 'packages/cli/src/runtime/sessionProgressSubscription.ts';
const TARGET_MODULE_STEM = TARGET_MODULE.replace(/\.(?:ts|tsx|mts|cts)$/, '');
const TARGET_ALIAS = '@cli/runtime/sessionProgressSubscription';
const TARGET_IMPORT_TOKEN = 'sessionProgressSubscription';

const ALLOWED_IMPORTERS = [
  'packages/cli/src/runtime/runExecution.ts',
  'src/test-kernel/cli/CliSessionProgressSubscription.vitest.mts',
  'src/test-kernel/cli/RunExecution.vitest.mts',
  'src/test-kernel/cli/RunProgressRenderer.vitest.mts',
] as const;

const SCAN_ROOTS = [
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const;

const SOURCE_OR_OUTPUT_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

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

function resolveCliAlias(specifier: string): string | null {
  if (specifier === TARGET_ALIAS) return TARGET_MODULE;
  if (!specifier.startsWith('@cli/')) return null;
  return `packages/cli/src/${specifier.slice('@cli/'.length)}`;
}

function resolveRepoRelativeImport(
  importer: string,
  specifier: string,
): string | null {
  if (specifier.startsWith('@cli/')) return resolveCliAlias(specifier);
  if (!specifier.startsWith('.')) return null;
  return toRepoPath(join(dirname(importer), specifier));
}

function resolvesToTarget(importer: string, specifier: string): boolean {
  const resolved = resolveRepoRelativeImport(importer, specifier);
  if (resolved == null) return false;

  if (resolved === TARGET_MODULE) return true;

  const resolvedStem = resolved.replace(SOURCE_OR_OUTPUT_EXTENSION, '');
  return resolvedStem === TARGET_MODULE_STEM;
}

function importsTargetModule(file: string): boolean {
  const sourceText = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  if (!sourceText.includes(TARGET_IMPORT_TOKEN)) return false;
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  return collectModuleSpecifiers(sourceFile).some((specifier) =>
    resolvesToTarget(file, specifier),
  );
}

describe('CLI session progress projection boundary', () => {
  it('keeps sessionProgressSubscription scoped to headless CLI NDJSON output', () => {
    expect(existsSync(resolve(REPO_ROOT, TARGET_MODULE))).toBe(true);

    const importers = SCAN_ROOTS.flatMap((root) =>
      sourceFilesUnder(resolve(REPO_ROOT, root), {
        missingDirReturnsEmpty: true,
        repoRelative: true,
      }),
    )
      .filter(importsTargetModule)
      .toSorted();

    expect(importers).toEqual([...ALLOWED_IMPORTERS].toSorted());
  });
});
