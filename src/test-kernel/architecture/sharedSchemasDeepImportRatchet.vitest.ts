// `@shared/schemas` deep-import ratchet (issue #9254). The maintainer ruled
// `@shared/schemas` a published surface: code imports the barrel, never a
// `@shared/schemas/<leaf>` module. Every classified grandfathering map this
// suite once carried is empty, so the gate is now a plain prohibition — any
// deep import from the scanned roots fails, and there is no baseline to
// regenerate.
//
// Scope: repo-root `src/` and every `packages/*/src`, excluding only the
// surface's own interior `src/shared/schemas/` (a sibling import there cannot
// use the barrel). test-kernel files are ratcheted like production.

// Node imports
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  collectModuleSpecifiers,
  parseSourceFile,
  REPO_ROOT,
  sourceFilesUnder,
  toRepoPath,
} from '../support/repoScan';

const SURFACE_INTERIOR = 'src/shared/schemas/';
const DEEP_IMPORT_PREFIX = '@shared/schemas/';

function scanRoots(): string[] {
  const packagesRoot = resolve(REPO_ROOT, 'packages');
  return [
    'src',
    ...readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/src`)
      .toSorted((a, b) => a.localeCompare(b)),
  ];
}

interface Scan {
  readonly deepImports: string[];
  readonly scannedFiles: number;
  readonly scannedTestKernelFiles: number;
}

function scanForDeepImports(): Scan {
  const deepImports: string[] = [];
  let scannedFiles = 0;
  let scannedTestKernelFiles = 0;

  for (const root of scanRoots()) {
    for (const file of sourceFilesUnder(resolve(REPO_ROOT, root), {
      excludeTestKernel: false,
      missingDirReturnsEmpty: true,
    })) {
      const repoPath = toRepoPath(file);
      if (repoPath.startsWith(SURFACE_INTERIOR)) continue;
      scannedFiles += 1;
      if (repoPath.startsWith('src/test-kernel/')) scannedTestKernelFiles += 1;
      // Cheap text gate before the parser: only ~300 of ~2k files can match,
      // and parsing the rest is what makes this ratchet slow enough to starve
      // its sibling suites of CPU when vitest runs them in parallel.
      const text = readFileSync(file, 'utf8');
      if (!text.includes(DEEP_IMPORT_PREFIX)) continue;
      for (const specifier of collectModuleSpecifiers(
        parseSourceFile(file, { text, setParentNodes: false }),
      )) {
        if (specifier.startsWith(DEEP_IMPORT_PREFIX)) {
          deepImports.push(`${repoPath}: ${specifier}`);
        }
      }
    }
  }

  return { deepImports, scannedFiles, scannedTestKernelFiles };
}

describe('@shared/schemas deep-import ratchet', () => {
  it('reaches @shared/schemas only through the published barrel', () => {
    const { deepImports, scannedFiles, scannedTestKernelFiles } =
      scanForDeepImports();

    // A broken scan would otherwise pass by finding nothing: pin that the
    // roots are really walked and that test-kernel files are in scope.
    expect(scannedFiles).toBeGreaterThan(1000);
    expect(scannedTestKernelFiles).toBeGreaterThan(0);

    expect(
      deepImports,
      `'@shared/schemas' is a published surface; import the barrel, not a leaf module:\n` +
        deepImports.map((entry) => `  ${entry}`).join('\n') +
        `\n\nIf a name is missing from the barrel, publish it there.`,
    ).toEqual([]);
  });

  // The forms the shared scanner covers. `module.require(...)`,
  // `require.resolve(...)` and `import.meta.resolve(...)` are deliberately
  // not covered: they appear zero times in the tree, and keeping a private
  // scanner for them is the machinery this ratchet just shed.
  it('detects a deep import in every scanned module-loading form', () => {
    const source = parseSourceFile('probe.ts', {
      setParentNodes: false,
      text: `
        import { AgentCategory } from '@shared/schemas/agent';
        export { AgentCategory } from '@shared/schemas/agent';
        import agent = require('@shared/schemas/agent');
        const dynamic = import('@shared/schemas/agent');
        const commonJs = require('@shared/schemas/agent');
        type Category = import('@shared/schemas/agent').AgentCategory;
      `,
    });

    expect(
      collectModuleSpecifiers(source).filter((specifier) =>
        specifier.startsWith(DEEP_IMPORT_PREFIX),
      ),
    ).toHaveLength(6);
  });
});
