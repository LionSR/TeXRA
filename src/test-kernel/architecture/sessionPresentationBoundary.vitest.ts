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
  it('keeps draft and recording state out of the shared SessionView', () => {
    const source = productionSource('src/shared/session/sessionView.ts');

    expect(source).not.toMatch(
      /followUpText|recording|polishedText|transcribedText|shouldFocusFollowUp/,
    );
  });
});
