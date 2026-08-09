// Node imports
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, sourceFilesUnder, toRepoPath } from '../support/repoScan';

const SCAN_ROOTS = [
  'src/model',
  'src/agent/modelHandlers',
  'src/agent/core',
  'src/agent/runtime',
] as const;

// New providers require a deliberate policy update in the backend-decoupling
// proposal and an allowlist update here.
const PERMITTED_THIRD_PARTY_OAUTH_ROOTS = new Set(['@auth/codex', '@auth/xai']);
const PERMITTED_THIRD_PARTY_OAUTH_PATHS = [
  'src/auth/codex',
  'src/auth/xai',
] as const;

function parseSourceFile(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function stringLiteralText(node: ts.Node): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function moduleSpecifier(node: ts.Node): string | null {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier == null
      ? null
      : stringLiteralText(node.moduleSpecifier);
  }
  if (ts.isImportEqualsDeclaration(node)) {
    const reference = node.moduleReference;
    return ts.isExternalModuleReference(reference)
      ? stringLiteralText(reference.expression)
      : null;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return stringLiteralText(node.argument.literal);
  }
  if (ts.isCallExpression(node)) {
    const [argument] = node.arguments;
    const loadsModule =
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require');
    return loadsModule && argument != null
      ? stringLiteralText(unwrapExpression(argument))
      : null;
  }
  return null;
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifier(node);
    if (specifier != null) specifiers.push(specifier);
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function authRoot(specifier: string): string | null {
  if (specifier === '@auth') return '@auth';
  if (!specifier.startsWith('@auth/')) return null;

  const segments = specifier.split('/');
  if (
    segments.slice(2).some((segment) => segment === '.' || segment === '..')
  ) {
    return '@auth';
  }

  const root = segments.at(1);
  return root == null || root.length === 0 ? '@auth' : `@auth/${root}`;
}

function relativeAuthPath(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;

  const path = toRepoPath(resolve(dirname(file), specifier)).replace(
    /\.(?:[cm]?[jt]sx?)$/,
    '',
  );
  return path === 'src/auth' || path.startsWith('src/auth/') ? path : null;
}

function isPermittedAuthPath(path: string): boolean {
  return PERMITTED_THIRD_PARTY_OAUTH_PATHS.some(
    (permittedPath) =>
      path === permittedPath || path.startsWith(`${permittedPath}/`),
  );
}

function isForbiddenAuthImport(file: string, specifier: string): boolean {
  const root = authRoot(specifier);
  if (root != null) return !PERMITTED_THIRD_PARTY_OAUTH_ROOTS.has(root);

  const path = relativeAuthPath(file, specifier);
  return path != null && !isPermittedAuthPath(path);
}

function findForbiddenAuthImports(file: string, source: string): string[] {
  return collectModuleSpecifiers(parseSourceFile(file, source)).filter(
    (specifier) => isForbiddenAuthImport(file, specifier),
  );
}

describe('hosted auth import boundary', () => {
  it('permits only documented third-party OAuth roots in model and runtime zones', () => {
    const violations = SCAN_ROOTS.flatMap((root) =>
      sourceFilesUnder(resolve(REPO_ROOT, root)).flatMap((file) =>
        findForbiddenAuthImports(file, readFileSync(file, 'utf8')).map(
          (specifier) => `${toRepoPath(file)}: ${specifier}`,
        ),
      ),
    );

    expect(violations).toEqual([]);
  });

  it('scans non-empty production zones', () => {
    const scannedFiles = SCAN_ROOTS.flatMap((root) =>
      sourceFilesUnder(resolve(REPO_ROOT, root)),
    );

    expect(scannedFiles.length).toBeGreaterThan(100);
  });

  it('rejects TeXRA-hosted and unapproved auth roots while permitting documented subpaths', () => {
    expect(
      findForbiddenAuthImports(
        resolve(REPO_ROOT, 'src/agent/runtime/fixture.ts'),
        `
          import { SupabaseClient } from '@auth/SupabaseClient';
          const relayToken = require('@auth/relayToken');
          const futureProvider = import('@auth/future-provider/oauth');
          const traversedRelay = import('@auth/codex/../relayToken');
          import { login } from '@auth/codex/oauth';
          export { login as xaiLogin } from '@auth/xai/callback';
        `,
      ),
    ).toEqual([
      '@auth/SupabaseClient',
      '@auth/relayToken',
      '@auth/future-provider/oauth',
      '@auth/codex/../relayToken',
    ]);
  });

  it('rejects relative static and dynamic imports into hosted auth', () => {
    expect(
      findForbiddenAuthImports(
        resolve(REPO_ROOT, 'src/agent/runtime/fixture.ts'),
        `
          import { SupabaseClient } from '../../auth/SupabaseClient';
          const relayToken = import('../../auth/relayToken', { with: { type: 'json' } });
          const codex = import('../../auth/codex/oauth');
        `,
      ),
    ).toEqual(['../../auth/SupabaseClient', '../../auth/relayToken']);
  });

  it('rejects asserted module arguments and dynamic imports with options', () => {
    expect(
      findForbiddenAuthImports(
        resolve(REPO_ROOT, 'src/agent/runtime/fixture.ts'),
        `
          const relayToken = require((('@auth/relayToken' as string)));
          const futureProvider = import((('@auth/future-provider' satisfies string)), {
            with: { type: 'json' },
          });
        `,
      ),
    ).toEqual(['@auth/relayToken', '@auth/future-provider']);
  });
});
