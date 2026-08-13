// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test support
import { REPO_ROOT, stripComments } from '../support/repoScan';

function productionSource(path: string): string {
  return stripComments(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
}

describe('session and presentation ownership boundary', () => {
  it('keeps selection and persisted presentation preferences out of SessionState', () => {
    const source = productionSource('src/controllers/session/SessionState.ts');

    expect(source).not.toMatch(/activeStream|PersistedState|presentation/i);
  });

  it('keeps focus policy and hydration reactions out of SessionFactApplier', () => {
    const source = productionSource(
      'src/controllers/session/SessionFactApplier.ts',
    );

    expect(source).not.toMatch(
      /suppressViewSwitch|ensureVisible|hasPendingPermissions|onActiveStreamChanged|syncStreamContent/,
    );
  });
});
