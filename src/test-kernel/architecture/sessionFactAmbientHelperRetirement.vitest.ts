// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  productionFilesUnder,
  REPO_ROOT,
  stripComments,
} from '../support/repoScan';

const SCAN_ROOTS = [
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const;

const RETIRED_AMBIENT_HELPER_SYMBOL = /\bemitRuntimeEvent\b/;

function referencesEmitRuntimeEvent(file: string): boolean {
  const source = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  return RETIRED_AMBIENT_HELPER_SYMBOL.test(source);
}

describe('ambient session-fact helper retirement', () => {
  it('keeps the retired ambient session-fact helper out of production code', () => {
    const references = SCAN_ROOTS.flatMap(productionFilesUnder)
      .filter(referencesEmitRuntimeEvent)
      .toSorted();

    expect(references).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    const scanned = SCAN_ROOTS.reduce(
      (total, root) => total + productionFilesUnder(root).length,
      0,
    );
    expect(scanned).toBeGreaterThan(100);
  });
});
