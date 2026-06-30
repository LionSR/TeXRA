// Standard library imports
import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { describe, it } from 'vitest';

async function collectTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('shared settings-view import boundaries', () => {
  it('does not import controller, agent, model, tool, or auth implementations directly', async () => {
    const sharedSettingsRoot = path.join(
      process.cwd(),
      'src/shared/settingsView',
    );
    const files = await collectTypeScriptFiles(sharedSettingsRoot);
    const directImplementationImport =
      /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"](?:@controllers\/|@agent\/|@model\/|@tools\/|@auth\/)/;
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (directImplementationImport.test(source)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }

    assert.deepEqual(offenders, []);
  });
});
