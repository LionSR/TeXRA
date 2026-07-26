// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  REPO_ROOT,
  sourceFilesUnder as sharedSourceFilesUnder,
} from '../support/repoScan';

const ALLOWED_PRODUCTION_REFERENCES = [] as const;

const SCAN_ROOTS = [
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const;

const RETIRED_AMBIENT_HELPER_SYMBOL = /\bemitRuntimeEvent\b/;

function sourceFilesUnder(root: string): string[] {
  return sharedSourceFilesUnder(resolve(REPO_ROOT, root), {
    missingDirReturnsEmpty: true,
    repoRelative: true,
    excludeTestKernel: true,
  });
}

function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const commentStart = line.indexOf('//');
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join('\n');
}

function referencesEmitRuntimeEvent(file: string): boolean {
  const source = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  return RETIRED_AMBIENT_HELPER_SYMBOL.test(source);
}

describe('ambient session-fact helper retirement', () => {
  it('keeps the retired ambient session-fact helper out of production code', () => {
    const references = SCAN_ROOTS.flatMap(sourceFilesUnder)
      .filter(referencesEmitRuntimeEvent)
      .toSorted();

    expect(references).toEqual([...ALLOWED_PRODUCTION_REFERENCES].toSorted());
  });

  it('actually scans the production source roots', () => {
    const scanned = SCAN_ROOTS.reduce(
      (total, root) => total + sourceFilesUnder(root).length,
      0,
    );
    expect(scanned).toBeGreaterThan(100);
  });
});
