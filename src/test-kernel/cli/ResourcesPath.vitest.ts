import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { resolveCliResourcesPath } from '@cli/runtime/resourcesPath';
import { nodeFileServices } from '@platform/defaults/jsonStore';
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
  it.live('prefers resources next to the executing validation bundle', () =>
    Effect.gen(function* () {
      const cliRoot = yield* Effect.promise(makeCliPackage);
      const validationResources = path.join(
        cliRoot,
        '.texra-validate-run',
        'resources',
      );
      yield* Effect.promise(() =>
        Promise.all([
          mkdir(path.join(cliRoot, 'dist', 'resources'), { recursive: true }),
          mkdir(validationResources, { recursive: true }),
        ]),
      );

      expect(
        yield* resolveCliResourcesPath(
          anchorUrl(
            path.join(cliRoot, '.texra-validate-run', 'bin', 'texra.js'),
          ),
        ),
      ).toBe(validationResources);
    }).pipe(Effect.provide(nodeFileServices)),
  );

  it.live('keeps the production bundle on dist resources', () =>
    Effect.gen(function* () {
      const cliRoot = yield* Effect.promise(makeCliPackage);
      const distResources = path.join(cliRoot, 'dist', 'resources');
      yield* Effect.promise(() => mkdir(distResources, { recursive: true }));

      expect(
        yield* resolveCliResourcesPath(
          anchorUrl(path.join(cliRoot, 'dist', 'bin', 'texra.js')),
        ),
      ).toBe(distResources);
    }).pipe(Effect.provide(nodeFileServices)),
  );
});
