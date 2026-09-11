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

const CLI_PROJECTION_MODULE =
  'packages/cli/src/runtime/sessionProgressSubscription.ts';

// The projection is the one writer of `kind: "progress"` NDJSON records, so
// its importers are the containment chain for headless output.
const ALLOWED_CLI_PROJECTION_IMPORTERS = [
  'packages/cli/src/runtime/executeCli.ts',
  'src/test-kernel/cli/CliSessionProgressSubscription.vitest.ts',
  'src/test-kernel/cli/ExecuteCli.vitest.ts',
  'src/test-kernel/cli/RunProgressRenderer.vitest.ts',
] as const;

const SOURCE_OR_OUTPUT_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const ALL_SOURCE_FILES = ALL_HOST_PRODUCTION_ROOTS.flatMap((root) =>
  sourceFilesUnder(resolve(REPO_ROOT, root), {
    missingDirReturnsEmpty: true,
    repoRelative: true,
    excludeTestKernel: false,
  }),
);
const SOURCE_TEXT_BY_FILE = new Map<string, string>();
const MODULE_SPECIFIERS_BY_FILE = new Map<string, string[]>();

function resolveRepoRelativeImport(
  importer: string,
  specifier: string,
): string | null {
  if (specifier.startsWith('@cli/')) {
    return `packages/cli/src/${specifier.slice('@cli/'.length)}`;
  }
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
  it('keeps the CLI projection scoped to headless NDJSON output', () => {
    const importers = ALL_SOURCE_FILES.filter((file) =>
      importsModule(file, CLI_PROJECTION_MODULE),
    ).toSorted();

    expect(importers).toEqual([...ALLOWED_CLI_PROJECTION_IMPORTERS].toSorted());
  });
});
