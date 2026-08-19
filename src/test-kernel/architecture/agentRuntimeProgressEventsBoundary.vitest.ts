// Node imports
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Third-party imports
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ALL_HOST_PRODUCTION_ROOTS,
  REPO_ROOT,
  SOURCE_FILE,
  sourceFilesUnder,
  toRepoPath,
} from '../support/repoScan';

const LEGACY_MODULE = 'src/agent/runtime/hostProgressEvents.ts';
const OLD_AGENT_RUNTIME_MODULE =
  'src/agent/runtime/agentRuntimeProgressEvents.ts';
const OLD_CLI_MODULE = 'packages/cli/src/runtime/cliProgressEvents.ts';
const CLI_NDJSON_MODULE = 'packages/cli/src/runtime/cliNdjsonProgressEvents.ts';
const OLD_TASK_STATE_PAYLOAD_MODULE =
  'src/agent/runtime/taskStateProgressPayload.ts';
const OLD_AGENT_RUNTIME_ALIAS = '@agent/runtime/agentRuntimeProgressEvents';
const OLD_CLI_ALIAS = '@cli/runtime/cliProgressEvents';
const CLI_NDJSON_ALIAS = '@cli/runtime/cliNdjsonProgressEvents';

const CLI_PROJECTION_MODULE =
  'packages/cli/src/runtime/sessionProgressSubscription.ts';

const ALLOWED_PRODUCTION_IMPORTERS = [CLI_PROJECTION_MODULE] as const;

// The projection module is the single production importer of the NDJSON
// vocabulary, so its own importers are part of the same containment chain.
const ALLOWED_CLI_PROJECTION_IMPORTERS = [
  'packages/cli/src/runtime/runExecution.ts',
  'src/test-kernel/cli/CliSessionProgressSubscription.vitest.ts',
  'src/test-kernel/cli/RunExecution.vitest.ts',
  'src/test-kernel/cli/RunProgressRenderer.vitest.ts',
] as const;

const SOURCE_OR_OUTPUT_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function scanFiles(excludeTestKernel: boolean): string[] {
  return ALL_HOST_PRODUCTION_ROOTS.flatMap((root) =>
    sourceFilesUnder(resolve(REPO_ROOT, root), {
      missingDirReturnsEmpty: true,
      repoRelative: true,
      excludeTestKernel,
    }),
  );
}

const PRODUCTION_FILES = scanFiles(true);
const ALL_SOURCE_FILES = scanFiles(false);
const SOURCE_TEXT_BY_FILE = new Map<string, string>();
const MODULE_SPECIFIERS_BY_FILE = new Map<string, string[]>();

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
  if (specifier === OLD_CLI_ALIAS) return OLD_CLI_MODULE;
  if (specifier === CLI_NDJSON_ALIAS) return CLI_NDJSON_MODULE;
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
  let sourceText = SOURCE_TEXT_BY_FILE.get(file);
  if (sourceText === undefined) {
    sourceText = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    SOURCE_TEXT_BY_FILE.set(file, sourceText);
  }

  const targetToken = basename(targetModule).replace(SOURCE_FILE, '');
  if (!sourceText.includes(targetToken)) return false;

  let moduleSpecifiers = MODULE_SPECIFIERS_BY_FILE.get(file);
  if (moduleSpecifiers === undefined) {
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );
    moduleSpecifiers = collectModuleSpecifiers(sourceFile);
    MODULE_SPECIFIERS_BY_FILE.set(file, moduleSpecifiers);
  }

  return moduleSpecifiers.some((specifier) =>
    resolvesToModule(file, specifier, targetModule),
  );
}

describe('agent runtime progress-event vocabulary boundary', () => {
  it('deletes the legacy hostProgressEvents module', () => {
    expect(existsSync(resolve(REPO_ROOT, LEGACY_MODULE))).toBe(false);
  });

  it.each<{
    name: string;
    modulePath: string;
    exists: boolean;
    allowedImporters: readonly string[];
    /** Test suites are in scope only where they appear in the allowlist. */
    scanTests?: boolean;
  }>([
    {
      name: 'removes the agent-runtime CLI progress vocabulary module',
      modulePath: OLD_AGENT_RUNTIME_MODULE,
      exists: false,
      allowedImporters: [],
    },
    {
      name: 'removes the neutral CLI progress vocabulary module',
      modulePath: OLD_CLI_MODULE,
      exists: false,
      allowedImporters: [],
    },
    {
      name: 'removes the agent-runtime task-state compatibility payload module',
      modulePath: OLD_TASK_STATE_PAYLOAD_MODULE,
      exists: false,
      allowedImporters: [],
    },
    {
      name: 'keeps the CLI compatibility vocabulary NDJSON-projection only',
      modulePath: CLI_NDJSON_MODULE,
      exists: true,
      allowedImporters: ALLOWED_PRODUCTION_IMPORTERS,
    },
    {
      name: 'keeps the CLI projection scoped to headless NDJSON output',
      modulePath: CLI_PROJECTION_MODULE,
      exists: true,
      allowedImporters: ALLOWED_CLI_PROJECTION_IMPORTERS,
      scanTests: true,
    },
  ])('$name', ({ modulePath, exists, allowedImporters, scanTests }) => {
    expect(existsSync(resolve(REPO_ROOT, modulePath))).toBe(exists);

    const importers = (scanTests ? ALL_SOURCE_FILES : PRODUCTION_FILES)
      .filter((file) => importsModule(file, modulePath))
      .toSorted();

    expect(importers).toEqual([...allowedImporters].toSorted());
  });
});
