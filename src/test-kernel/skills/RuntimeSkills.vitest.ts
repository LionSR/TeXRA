import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect } from 'vitest';

import { ToolError } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  activatedSkillNames,
  loadRuntimeSkillCatalog as loadRuntimeSkillCatalogEffect,
} from '@skills/runtimeSkills';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { setupPlatform } from '@test/support/setupPlatform';
import { testSkillRoots, writeSkill } from '@test/support/skillFixtures';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { resolveToolPath } from '@tools/pathResolution';
import type { StepRoot } from '@utils/files/externalRoots';

const tempRoots = useTempDirs();
/** The run catalog of `workspacePath`, with no installed plugin loading. */
const runCatalog = (workspacePath: string) => ({
  roots: { ...testWorkspaceRoots(), workspace: workspacePath },
  plugins: { loadable: [], withheld: [] },
});

async function createTempRoot(): Promise<string> {
  return makeTempDir('texra-runtime-skills-', tempRoots);
}

const WORKSPACE_ROOT = '/workspace';
setupPlatform({ workspacePath: WORKSPACE_ROOT });

afterEach(async () => {
  await Effect.runPromise(
    testWorkspaceRoots().config.update(
      WorkspaceStateKey.DISABLED_SKILLS,
      undefined,
    ),
  );
});

describe('runtime skills', () => {
  it.effect('filters runtime skills disabled by name', () =>
    Effect.gen(function* () {
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
      yield* testWorkspaceRoots().config.update(
        WorkspaceStateKey.DISABLED_SKILLS,
        ['project-skill'],
      );

      const result = yield* loadRuntimeSkillCatalogEffect(
        runCatalog(WORKSPACE_ROOT),
      ).pipe(
        Effect.provide(
          testSkillRoots([
            { tier: 'project', path: projectRoot },
            { tier: 'user', path: userRoot },
          ]),
        ),
      );

      expect(result.catalog.map(({ name }) => name)).toStrictEqual([
        'user-skill',
      ]);
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  // Fails if a skill root one step admits reaches a call without it (another
  // run of the same project, or a later step that no longer lists it), or if
  // the step holding it cannot read it. The skill sits outside the project,
  // so only the step's roots can admit it.
  it.effect(
    "admits a step's listed or activated skill directory to its calls only",
    () =>
      Effect.gen(function* () {
        const skillsRoot = yield* Effect.promise(createTempRoot);
        const skillPath = yield* Effect.promise(() =>
          writeSkill(
            skillsRoot,
            'shared-notes',
            { name: 'shared-notes', description: 'Shared notes.' },
            'Read the notes.',
          ),
        );
        const projectA = path.resolve(path.sep, 'project-a');
        const { catalog } = yield* loadRuntimeSkillCatalogEffect(
          runCatalog(projectA),
        ).pipe(
          Effect.provide(testSkillRoots([{ tier: 'user', path: skillsRoot }])),
          Effect.provide(nodePlatformLayer),
        );
        const rootsOf = (listed: typeof catalog) =>
          listed.flatMap(({ name, directory }) =>
            directory === null
              ? []
              : [{ absolutePath: directory, label: `Skill ${name}` }],
          );
        const resolveFrom = (stepRoots: readonly StepRoot[]) =>
          resolveToolPath(
            {
              roots: { ...testWorkspaceRoots(), workspace: projectA },
              stepRoots,
            },
            skillPath,
          );

        expect((yield* resolveFrom(rootsOf(catalog))).external?.writable).toBe(
          false,
        );
        // Another run's call, or a step that no longer lists the skill.
        expect(yield* Effect.flip(resolveFrom([]))).toBeInstanceOf(ToolError);
        // A skill the user activated by name is granted again, even unlisted.
        const names = activatedSkillNames([
          '<skill_activation>\nThe user selected it.\n<skill name="shared-notes">\n</skill>\n</skill_activation>',
        ]);
        expect(names).toEqual(['shared-notes']);
        const activated = catalog.filter(({ name }) => names.includes(name));
        expect(
          (yield* resolveFrom(rootsOf(activated))).external?.writable,
        ).toBe(false);
      }),
  );
});
