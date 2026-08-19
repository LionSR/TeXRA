import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveCliResourcesPath } from '@cli/runtime/resourcesPath';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempRoots = useTempDirs();

async function makeCliPackage() {
  const root = await makeTempDir('texra-cli-resources-', tempRoots);
  const cliRoot = path.join(root, 'packages', 'cli');
  await mkdir(cliRoot, { recursive: true });
  await writeFile(path.join(cliRoot, 'package.json'), '{}\n');
  return cliRoot;
}

function anchorUrl(filePath: string) {
  return pathToFileURL(filePath).href;
}

describe('resolveCliResourcesPath', () => {
  it('prefers resources next to the executing validation bundle', async () => {
    const cliRoot = await makeCliPackage();
    const validationResources = path.join(
      cliRoot,
      '.texra-validate-run',
      'resources',
    );
    await Promise.all([
      mkdir(path.join(cliRoot, 'dist', 'resources'), { recursive: true }),
      mkdir(validationResources, { recursive: true }),
    ]);

    expect(
      resolveCliResourcesPath(
        anchorUrl(path.join(cliRoot, '.texra-validate-run', 'bin', 'texra.js')),
      ),
    ).toBe(validationResources);
  });

  it('keeps the production bundle on dist resources', async () => {
    const cliRoot = await makeCliPackage();
    const distResources = path.join(cliRoot, 'dist', 'resources');
    await mkdir(distResources, { recursive: true });

    expect(
      resolveCliResourcesPath(
        anchorUrl(path.join(cliRoot, 'dist', 'bin', 'texra.js')),
      ),
    ).toBe(distResources);
  });
});
