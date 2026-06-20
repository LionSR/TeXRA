// Standard library imports
import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { describe, it } from 'vitest';

async function collectTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(entryPath)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

describe('shared settings-view import boundaries', () => {
  it('does not import tool or auth implementations directly', async () => {
    const sharedSettingsRoot = path.join(
      process.cwd(),
      'src/shared/settingsView',
    );
    const files = await collectTypeScriptFiles(sharedSettingsRoot);
    const directImplementationImport =
      /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"](?:@tools|@auth)\//;
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
