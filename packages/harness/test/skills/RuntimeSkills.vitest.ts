import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { expect } from 'vitest';

import {
  HostSkillSources,
  loadRuntimeSkillCatalog as loadRuntimeSkillCatalogEffect,
} from '@skills/runtimeSkills';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { FakeHost } from '@test/support/testKernel';
import { writeSkill } from '@test/support/skillFixtures';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { DISABLED_SKILLS_SETTING } from '@texra-ai/worldline/schemas';
import type { WorkspaceRoots } from '@platform/workspaceRoots';

const tempRoots = useTempDirs();
/** The run catalog of `workspaceRoot` over `roots`, with no installed
 *  plugin loading. */
const runCatalog = (roots: WorkspaceRoots, workspaceRoot: string) => ({
  roots: { ...roots, workspace: workspaceRoot },
  plugins: { loadable: [], withheld: [] },
});

/** The process's skill sources: the fixture roots as custom roots, in
 *  order, over an empty resources tree. */
const testSkillRoots = (paths: readonly string[], resourcesPath: string) =>
  Layer.succeed(HostSkillSources)({
    resourcesPath,
    projectDataDirName: undefined,
    pluginIds: [],
    options: { additionalPaths: paths },
  });

async function createTempRoot(): Promise<string> {
  return makeTempDir('texra-runtime-skills-', tempRoots);
}

const WORKSPACE_ROOT = '/workspace';

// Each test's host is its own, so a skill one disables reaches no other.
layer(FakeHost.layer({ workspaceRoot: WORKSPACE_ROOT }), {
  buildPerTest: true,
})('runtime skills', (it) => {
  it.effect('filters runtime skills disabled by name', () =>
    Effect.gen(function* () {
      const { roots } = yield* FakeHost;
      const projectRoot = yield* Effect.promise(() => createTempRoot());
      const userRoot = yield* Effect.promise(() => createTempRoot());
      yield* Effect.promise(() =>
        writeSkill(projectRoot, 'project-skill', {
          name: 'project-skill',
          description: 'Project skill.',
        }),
      );
      yield* Effect.promise(() =>
        writeSkill(userRoot, 'user-skill', {
          name: 'user-skill',
          description: 'User skill.',
        }),
      );
      yield* roots.config.update(DISABLED_SKILLS_SETTING.key, [
        'project-skill',
      ]);

      const result = yield* loadRuntimeSkillCatalogEffect(
        runCatalog(roots, WORKSPACE_ROOT),
      ).pipe(
        Effect.provide(
          testSkillRoots(
            [projectRoot, userRoot],
            yield* Effect.promise(createTempRoot),
          ),
        ),
      );

      expect(result.catalog.map(({ name }) => name)).toStrictEqual([
        'user-skill',
      ]);
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
