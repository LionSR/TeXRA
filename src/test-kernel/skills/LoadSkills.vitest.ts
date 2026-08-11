import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverSkills, discoverSkillSources } from '@skills/loadSkills';
import { writeSkill } from '@test/support/skillFixtures';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  return makeTempDir('texra-skills-', tempRoots);
}

afterEach(async () => {
  await cleanupTempDirs(tempRoots);
});

type DiscoveryOutcome = {
  skills: Array<{ skill: { name: string } }>;
  errors: readonly unknown[];
};

function skillNames(result: DiscoveryOutcome): string[] {
  return result.skills.map(({ skill }) => skill.name);
}

function expectReportedIssue(
  result: DiscoveryOutcome,
  issue: Record<string, unknown>,
): void {
  expect(result.errors).toContainEqual(expect.objectContaining(issue));
}

describe('discoverSkills', () => {
  it('loads valid SKILL.md packages', async () => {
    const root = await createTempRoot();
    await writeSkill(
      root,
      'manuscript-review',
      {
        name: 'manuscript-review',
        description:
          'Reviews mathematical manuscripts for correctness and exposition.',
      },
      'Read the paper and report substantial mathematical issues.',
    );

    const result = await discoverSkills(root);

    expect(result.errors).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.skill).toMatchObject({
      name: 'manuscript-review',
      description:
        'Reviews mathematical manuscripts for correctness and exposition.',
      body: 'Read the paper and report substantial mathematical issues.',
    });
  });

  it('rejects skills without descriptions', async () => {
    const root = await createTempRoot();
    await writeSkill(root, 'missing-description', {
      name: 'missing-description',
    });

    const result = await discoverSkills(root);

    expect(result.skills).toEqual([]);
    expectReportedIssue(result, {
      severity: 'error',
      code: 'missing_description',
    });
  });

  it('loads name-mismatched skills with a warning', async () => {
    const root = await createTempRoot();
    await writeSkill(root, 'directory-name', {
      name: 'frontmatter-name',
      description: 'A skill whose declared name differs from its directory.',
    });

    const result = await discoverSkills(root);

    expect(skillNames(result)).toEqual(['frontmatter-name']);
    expectReportedIssue(result, {
      severity: 'warning',
      code: 'name_mismatch',
      name: 'frontmatter-name',
    });
  });

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

    const result = await discoverSkills(root);

    expect(skillNames(result)).toEqual(['valid-skill']);
    expectReportedIssue(result, {
      severity: 'error',
      code: 'invalid_frontmatter',
    });
  });

  it('deduplicates symlinked skill packages by real path', async () => {
    const root = await createTempRoot();
    const actualSkill = await writeSkill(root, 'actual-skill', {
      name: 'actual-skill',
      description: 'A skill reached through a real directory and a symlink.',
    });
    await fs.symlink(
      path.dirname(actualSkill),
      path.join(root, 'linked-skill'),
      'dir',
    );

    const result = await discoverSkills(root);

    expect(skillNames(result)).toEqual(['actual-skill']);
    expectReportedIssue(result, {
      severity: 'warning',
      code: 'duplicate_realpath',
    });
  });

  it('keeps the first skill when names collide', async () => {
    const root = await createTempRoot();
    await writeSkill(root, 'alpha', {
      name: 'repeated-name',
      description: 'The first skill with this name.',
    });
    await writeSkill(root, 'beta', {
      name: 'repeated-name',
      description: 'The second skill with this name.',
    });

    const result = await discoverSkills(root);

    expect(result.skills.map(({ skill }) => skill.description)).toEqual([
      'The first skill with this name.',
    ]);
    expectReportedIssue(result, {
      severity: 'warning',
      code: 'duplicate_name',
      name: 'repeated-name',
    });
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
    expect(result.skills.map(({ source }) => source.scope)).toEqual([
      'bundled',
      'project',
    ]);
    expectReportedIssue(result, {
      severity: 'warning',
      code: 'duplicate_name',
      name: 'shared-skill',
    });
  });

  it('reports missing required sources without treating optional roots as errors', async () => {
    const optional = path.join(os.tmpdir(), 'texra-skills-optional-missing');
    const required = path.join(os.tmpdir(), 'texra-skills-required-missing');

    const result = await discoverSkillSources([
      { scope: 'user', path: optional },
      { scope: 'custom', path: required, required: true },
    ]);

    expect(result.skills).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'missing_source',
        path: required,
      }),
    ]);
  });

  it('reports required sources that are not directories', async () => {
    const root = await createTempRoot();
    const required = path.join(root, 'skills-file');
    await fs.writeFile(required, 'not a directory');

    const result = await discoverSkillSources([
      { scope: 'custom', path: required, required: true },
    ]);

    expect(result.skills).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'invalid_source',
        path: required,
      }),
    ]);
  });
});
