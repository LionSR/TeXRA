// Node imports
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  ALL_HOST_PRODUCTION_ROOTS,
  collectModuleSpecifiers,
  parseSourceFile,
  REPO_ROOT,
  SOURCE_FILE,
  sourceFilesUnder,
  toRepoPath,
} from '../support/repoScan';

const CLI_NDJSON_MODULE = 'packages/cli/src/runtime/cliNdjsonProgressEvents.ts';
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

function resolveCliAlias(specifier: string): string | null {
  if (specifier === CLI_NDJSON_ALIAS) return CLI_NDJSON_MODULE;
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
    moduleSpecifiers = collectModuleSpecifiers(
      parseSourceFile(file, { text: sourceText }),
    );
    MODULE_SPECIFIERS_BY_FILE.set(file, moduleSpecifiers);
  }

  return moduleSpecifiers.some((specifier) =>
    resolvesToModule(file, specifier, targetModule),
  );
}

describe('agent runtime progress-event vocabulary boundary', () => {
  it.each<{
    name: string;
    modulePath: string;
    allowedImporters: readonly string[];
    /** Test suites are in scope only where they appear in the allowlist. */
    scanTests?: boolean;
  }>([
    {
      name: 'keeps the CLI compatibility vocabulary NDJSON-projection only',
      modulePath: CLI_NDJSON_MODULE,
      allowedImporters: ALLOWED_PRODUCTION_IMPORTERS,
    },
    {
      name: 'keeps the CLI projection scoped to headless NDJSON output',
      modulePath: CLI_PROJECTION_MODULE,
      allowedImporters: ALLOWED_CLI_PROJECTION_IMPORTERS,
      scanTests: true,
    },
  ])('$name', ({ modulePath, allowedImporters, scanTests }) => {
    const importers = (scanTests ? ALL_SOURCE_FILES : PRODUCTION_FILES)
      .filter((file) => importsModule(file, modulePath))
      .toSorted();

    expect(importers).toEqual([...allowedImporters].toSorted());
  });
});
