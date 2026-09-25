import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect } from 'vitest';

import {
  ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS,
  ActiveSkillsSnapshotSchema,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  formatRuntimeSkillActivation,
  loadRuntimeSkillCatalog as loadRuntimeSkillCatalogEffect,
} from '@skills/runtimeSkills';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { setupPlatform } from '@test/support/setupPlatform';
import { installTestSkillRoots, writeSkill } from '@test/support/skillFixtures';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempRoots = useTempDirs();

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

function catalogSkillNames(catalog: string): string[] {
  return [...catalog.matchAll(/^- ([^:]+):/gm)].map((match) => match[1]);
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

    const result = await loadRuntimeSkillCatalog(
      WORKSPACE_ROOT,
      testWorkspaceRoots(),
    );

    expect(result.catalog).toContain(
      '- manuscript-review: Review mathematical manuscripts.',
    );
    expect(result.catalog).toContain('Source: project');
    expect(result.catalog).toContain(`Path: ${skillPath}`);
    expect(result.skills).toStrictEqual([
      {
        name: 'manuscript-review',
        description: 'Review mathematical manuscripts.',
        source: 'project',
      },
    ]);
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
        WORKSPACE_ROOT,
        testWorkspaceRoots(),
      );

      expect(result.skills.map((skill) => skill.name)).toStrictEqual(expected);
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it('bounds the accepted set once before prompt and snapshot projection', async () => {
    const root = await createTempRoot();
    const discoveredCount = ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS + 2;
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

    const result = await loadRuntimeSkillCatalog(
      WORKSPACE_ROOT,
      testWorkspaceRoots(),
    );
    const catalogNames = catalogSkillNames(result.catalog);
    const snapshotNames = result.skills.map((skill) => skill.name);

    expect(snapshotNames).toHaveLength(ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS);
    expect(catalogNames).toStrictEqual(snapshotNames);
    expect(snapshotNames.at(-1)).toBe('skill-199');
    expect(result.catalog).not.toContain('skill-200');

    expect(
      ActiveSkillsSnapshotSchema.parse({ skills: result.skills }),
    ).toStrictEqual({ skills: result.skills });
  });
});
