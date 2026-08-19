// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  ALL_HOST_PRODUCTION_ROOTS,
  expectRealCoverage,
  productionFilesUnder,
  REPO_ROOT,
  stripComments,
} from '../support/repoScan';

const RETIRED_AMBIENT_HELPER_SYMBOL = /\bemitRuntimeEvent\b/;

function referencesEmitRuntimeEvent(file: string): boolean {
  const source = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  return RETIRED_AMBIENT_HELPER_SYMBOL.test(source);
}

describe('ambient session-fact helper retirement', () => {
  it('keeps the retired ambient session-fact helper out of production code', () => {
    const references = ALL_HOST_PRODUCTION_ROOTS.flatMap(productionFilesUnder)
      .filter(referencesEmitRuntimeEvent)
      .toSorted();

    expect(references).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    expectRealCoverage(ALL_HOST_PRODUCTION_ROOTS);
  });
});
