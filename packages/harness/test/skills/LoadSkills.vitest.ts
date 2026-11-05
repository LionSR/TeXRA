import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
  discoverSkillSources as discoverSkillSourcesEffect,
  type SkillSource,
} from '@skills/loadSkills';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { writeSkill } from '@test/support/skillFixtures';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempRoots = useTempDirs();

/** One source-ordered tier: each root scanned in turn. */
const discoverSkillSources = (sources: readonly SkillSource[]) =>
  Effect.runPromise(
    discoverSkillSourcesEffect([{ order: 'source', sources }]).pipe(
      Effect.provide(nodePlatformLayer),
    ),
  );

async function createTempRoot(): Promise<string> {
  return makeTempDir('texra-skills-', tempRoots);
}

describe('discoverSkillSources over one root', () => {
  it('reports invalid YAML frontmatter without aborting discovery', async () => {
    const root = await createTempRoot();
    await writeSkill(root, 'valid-skill', {
      name: 'valid-skill',
      description: 'A valid skill.',
    });
    const invalidDir = path.join(root, 'invalid-skill');
    await fs.mkdir(invalidDir);
    await fs.writeFile(
      path.join(invalidDir, 'SKILL.md'),
      `---\nname: : bad\n---\n\nBody\n`,
    );

    const result = await discoverSkillSources([
      { scope: 'project', path: root },
    ]);

    expect(result.skills.map(({ skill }) => skill.name)).toEqual([
      'valid-skill',
    ]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'invalid_frontmatter',
      }),
    );
  });
});

describe('discoverSkillSources', () => {
  it('keeps source precedence across multiple roots', async () => {
    const bundled = await createTempRoot();
    const project = await createTempRoot();
    await writeSkill(bundled, 'shared-skill', {
      name: 'shared-skill',
      description: 'The bundled version.',
    });
    await writeSkill(project, 'shared-skill', {
      name: 'shared-skill',
      description: 'The project version.',
    });
    await writeSkill(project, 'project-only', {
      name: 'project-only',
      description: 'A project-specific skill.',
    });

    const result = await discoverSkillSources([
      { scope: 'bundled', path: bundled },
      { scope: 'project', path: project },
    ]);

    expect(result.skills.map(({ skill }) => skill.description)).toEqual([
      'The bundled version.',
      'A project-specific skill.',
    ]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'duplicate_name',
        name: 'shared-skill',
      }),
    );
  });
});
