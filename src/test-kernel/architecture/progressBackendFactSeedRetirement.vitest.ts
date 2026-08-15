// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, stripComments } from '../support/repoScan';

const PROGRESS_BACKEND =
  'src/controllers/progressView/backend/ProgressBackend.ts';

const RETIRED_FACT_SEED = /\bapply(?:Session|Run)Fact\b/;
const DOCUMENTED_STATUS_SEED = /\bapplyStreamStatus\b/;

function progressBackendSource(): string {
  return stripComments(
    readFileSync(resolve(REPO_ROOT, PROGRESS_BACKEND), 'utf8'),
  );
}

describe('ProgressBackend fact-seed retirement', () => {
  it('keeps the retired applySessionFact/applyRunFact test seeds off ProgressBackend', () => {
    expect(RETIRED_FACT_SEED.test(progressBackendSource())).toBe(false);
  });

  it('keeps applyStreamStatus, the documented awaitable status seed', () => {
    expect(DOCUMENTED_STATUS_SEED.test(progressBackendSource())).toBe(true);
  });
});
