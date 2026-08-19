/**
 * Repo file-discovery and TypeScript-parsing plumbing shared by the
 * architecture ratchet tests under src/test-kernel/architecture/. Each ratchet
 * keeps its own baseline-diff logic and any richer AST extraction it needs
 * (edge kinds, per-binding type-space); the file walk, the parse call, and the
 * plain "which modules does this file load" scan live here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { expect } from 'vitest';

export const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

/** The four host production roots most architecture ratchets scan. */
export const ALL_HOST_PRODUCTION_ROOTS = Object.freeze([
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const);

export const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;

export function toRepoPath(path: string): string {
  return relative(REPO_ROOT, resolve(REPO_ROOT, path)).replaceAll('\\', '/');
}

export function sourceFilesUnder(
  dir: string,
  opts?: {
    /** Return [] instead of throwing when `dir` doesn't exist. */
    readonly missingDirReturnsEmpty?: boolean;
    /** Return repo-relative paths instead of absolute ones. */
    readonly repoRelative?: boolean;
    /** Drop files under src/test-kernel/. */
    readonly excludeTestKernel?: boolean;
  },
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch (error) {
    if (opts?.missingDirReturnsEmpty) return [];
    throw error;
  }

  return entries
    .filter((entry) => SOURCE_FILE.test(entry) && !entry.endsWith('.d.ts'))
    .map((entry) => join(dir, entry))
    .filter(
      (file) =>
        !opts?.excludeTestKernel ||
        !toRepoPath(file).startsWith('src/test-kernel/'),
    )
    .map((file) => (opts?.repoRelative ? toRepoPath(file) : file));
}

/** repo-relative, test-kernel-excluded source files under `root`, missing dir -> []. */
export function productionFilesUnder(root: string): string[] {
  return sourceFilesUnder(resolve(REPO_ROOT, root), {
    missingDirReturnsEmpty: true,
    repoRelative: true,
    excludeTestKernel: true,
  });
}

/** Guards against a silently-vacuous scan across `roots` matching none of `min`. */
export function expectRealCoverage(roots: readonly string[], min = 100): void {
  const scanned = roots.reduce(
    (total, root) => total + productionFilesUnder(root).length,
    0,
  );
  expect(scanned).toBeGreaterThan(min);
}

export function parseSourceFile(
  file: string,
  opts?: {
    /** Source text, when the caller already read it or is parsing a fixture. */
    readonly text?: string;
    /**
     * Parent pointers roughly double the parse cost; pass `false` when nothing
     * walks upward and the scan covers thousands of files.
     */
    readonly setParentNodes?: boolean;
  },
): ts.SourceFile {
  // No ScriptKind argument: ts.createSourceFile derives it from the file name,
  // so a .tsx path already parses as TSX.
  return ts.createSourceFile(
    file,
    opts?.text ?? readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    opts?.setParentNodes ?? true,
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

/** The module `node` loads, across every form that loads one. */
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

/**
 * Every module specifier `sourceFile` loads, in source order: static
 * import/export, `import x = require(…)`, `typeof import(…)` type positions,
 * and dynamic `import(…)` / `require(…)` calls (import attributes and asserted
 * arguments included).
 */
export function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifier(node);
    if (specifier != null) specifiers.push(specifier);
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

/** Drop comments so a prose mention like "do not import from 'vscode'" can't
 *  trip a source-pattern check. Naive `//` stripping is fine here: a real
 *  import precedes any trailing comment, and cutting mid-string only matters
 *  on lines that never contain the pattern being checked for anyway. */
export function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const commentStart = line.indexOf('//');
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join('\n');
}
