import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'vitest';

import { sourceFilesUnder, toRepoPath } from '../support/repoScan';

describe('shared settings-view import boundaries', () => {
  it('does not import controller, agent, model, tool, or auth implementations directly', async () => {
    const files = sourceFilesUnder('src/shared/settingsView').filter((file) =>
      file.endsWith('.ts'),
    );
    const directImplementationImport =
      /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"](?:@controllers\/|@agent\/|@model\/|@tools\/|@auth\/)/;
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (directImplementationImport.test(source)) {
        offenders.push(toRepoPath(file));
      }
    }

    assert.deepEqual(offenders, []);
  });
});
