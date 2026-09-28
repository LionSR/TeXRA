import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect } from 'vitest';

import { SKILL_CATALOG_MAX_SKILLS, ToolError } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  activatedSkillEntries,
  formatRuntimeSkillActivation,
  loadRuntimeSkillCatalog as loadRuntimeSkillCatalogEffect,
} from '@skills/runtimeSkills';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { setupPlatform } from '@test/support/setupPlatform';
import { installTestSkillRoots, writeSkill } from '@test/support/skillFixtures';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { resolveToolPath } from '@tools/pathResolution';
import { skillRoots, type StepRoot } from '@utils/files/externalRoots';

const tempRoots = useTempDirs();
/** The run catalog of `workspacePath`, with no installed plugin loading. */
const runCatalog = (workspacePath: string) => ({
  workspacePath,
  settings: testWorkspaceRoots(),
  installed: Effect.succeed({ loadable: [], withheld: [] }),
});

const loadRuntimeSkillCatalog = (
  ...args: Parameters<typeof loadRuntimeSkillCatalogEffect>
) =>
  Effect.runPromise(
    loadRuntimeSkillCatalogEffect(...args).pipe(
      Effect.provide(nodePlatformLayer),
    ),
  );

async function createTempRoot(): Promise<string> {
  return makeTempDir('texra-runtime-skills-', tempRoots);
}

const catalogText = (catalog: readonly { readonly text: string }[]) =>
  catalog.map(({ text }) => text).join('\n');

function catalogSkillNames(catalog: readonly { readonly text: string }[]) {
  return [...catalogText(catalog).matchAll(/^- ([^:]+):/gm)].map(
    (match) => match[1],
  );
}

const WORKSPACE_ROOT = '/workspace';
setupPlatform({ workspacePath: WORKSPACE_ROOT });

afterEach(async () => {
  installTestSkillRoots([]);
  await Effect.runPromise(
    testWorkspaceRoots().config.update(
      WorkspaceStateKey.DISABLED_SKILLS,
      undefined,
    ),
  );
  await Effect.runPromise(
    testWorkspaceRoots().config.update(
      WorkspaceStateKey.DISABLED_SKILL_SOURCES,
      undefined,
    ),
  );
});

describe('runtime skills', () => {
  it('formats selected skills for activation with skill directory substitution', () => {
    const activation = formatRuntimeSkillActivation({
      skill: {
        name: 'proof-audit',
        description: 'Review mathematical proof steps.',
        body: 'Read ${TEXRA_SKILL_DIR}/references/checklist.md first & compare <proof>.',
        baseDir: '/tmp/proof-audit',
        path: '/tmp/proof-audit/SKILL.md',
      },
      source: {
        scope: 'project',
        path: '/tmp/.texra/skills',
        label: 'project',
      },
    });

    expect(activation).toContain('<skill name="proof-audit">');
    expect(activation).toContain('<source>project</source>');
    expect(activation).toContain(
      'Read /tmp/proof-audit/references/checklist.md first &amp; compare &lt;proof>.',
    );
  });

  it('formats configured runtime skills for prompt injection', async () => {
    const root = await createTempRoot();
    const skillPath = await writeSkill(
      root,
      'manuscript-review',
      {
        name: 'manuscript-review',
        description: 'Review mathematical manuscripts.',
      },
      'Use manuscript-review when it applies.',
    );
    installTestSkillRoots([{ tier: 'project', path: root }]);

    const result = await loadRuntimeSkillCatalog(runCatalog(WORKSPACE_ROOT));

    expect(catalogText(result.catalog)).toContain(
      '- manuscript-review: Review mathematical manuscripts.',
    );
    expect(catalogText(result.catalog)).toContain('Source: project');
    expect(catalogText(result.catalog)).toContain(`Path: ${skillPath}`);
    expect(
      result.catalog.map(({ plugin, name }) => ({ plugin, name })),
    ).toStrictEqual([{ plugin: null, name: 'manuscript-review' }]);
    expect(result.issues).toEqual([]);
  });

  it.effect.each([
    {
      label: 'name',
      key: WorkspaceStateKey.DISABLED_SKILLS,
      value: ['project-skill'],
      expected: ['user-skill'],
    },
    {
      label: 'source',
      key: WorkspaceStateKey.DISABLED_SKILL_SOURCES,
      value: ['user'],
      expected: ['project-skill'],
    },
  ])('filters runtime skills disabled by $label', ({ key, value, expected }) =>
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
      installTestSkillRoots([
        { tier: 'project', path: projectRoot },
        { tier: 'user', path: userRoot },
      ]);
      yield* testWorkspaceRoots().config.update(key, value);

      const result = yield* loadRuntimeSkillCatalogEffect(
        runCatalog(WORKSPACE_ROOT),
      );

      expect(result.catalog.map(({ name }) => name)).toStrictEqual(expected);
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it('bounds the catalog of one source', async () => {
    const root = await createTempRoot();
    const discoveredCount = SKILL_CATALOG_MAX_SKILLS + 2;
    await Promise.all(
      Array.from({ length: discoveredCount }, (_, index) => {
        const name = `skill-${index.toString().padStart(3, '0')}`;
        return writeSkill(
          root,
          name,
          { name, description: `Description ${index}.` },
          `Apply ${name}.`,
        );
      }),
    );
    installTestSkillRoots([{ tier: 'project', path: root }]);

    const result = await loadRuntimeSkillCatalog(runCatalog(WORKSPACE_ROOT));
    const catalogNames = catalogSkillNames(result.catalog);

    expect(catalogNames).toHaveLength(SKILL_CATALOG_MAX_SKILLS);
    expect(result.catalog.map(({ name }) => name)).toStrictEqual(catalogNames);
    expect(catalogNames.at(-1)).toBe('skill-199');
    expect(catalogText(result.catalog)).not.toContain('skill-200');
  });

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
        installTestSkillRoots([{ tier: 'user', path: skillsRoot }]);
        const projectA = path.resolve(path.sep, 'project-a');
        const { catalog } = yield* loadRuntimeSkillCatalogEffect(
          runCatalog(projectA),
        ).pipe(Effect.provide(nodePlatformLayer));
        const rootsOf = (listed: typeof catalog) => {
          const { roots, refused } = skillRoots(
            listed.flatMap(({ name, directory }) =>
              directory === null ? [] : [{ name, directory }],
            ),
          );
          expect(refused).toEqual([]);
          return roots;
        };
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
        const activated = yield* activatedSkillEntries(
          [
            '<skill_activation>\nThe user selected it.\n<skill name="shared-notes">\n</skill>\n</skill_activation>',
          ],
          projectA,
          testWorkspaceRoots(),
        ).pipe(Effect.provide(nodePlatformLayer));
        expect(activated.map(({ name }) => name)).toEqual(['shared-notes']);
        expect(
          (yield* resolveFrom(rootsOf(activated))).external?.writable,
        ).toBe(false);
      }),
  );
});
