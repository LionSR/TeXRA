import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatCliSkillList,
  readCliRuntimeSkills,
  readCliSkills,
  skillListRecord,
} from '@cli/runtime/skills';
import { defaultSkillSources } from '@skills/skillSources';
import { setRuntimeSkillSources } from '@skills/runtimeSkills';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempRoots = useTempDirs();
const commandMocks = vi.hoisted(() => ({ initCliPlatform: vi.fn() }));

vi.mock('@cli/runtime/initPlatform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/initPlatform')>()),
  initCliPlatform: commandMocks.initCliPlatform,
}));

const { runCli } = await import('@cli/commands/root');

async function writeSkill(
  root: string,
  dirName: string,
  description: string,
): Promise<void> {
  const skillDir = path.join(root, dirName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${dirName}\ndescription: ${description}\n---\n\nUse ${dirName}.\n`,
  );
}

afterEach(() => {
  setRuntimeSkillSources([]);
  commandMocks.initCliPlatform.mockReset();
});

describe('CLI skills runtime', () => {
  it('deduplicates repeated source paths while preserving required custom roots', () => {
    const projectSkillsPath = path.resolve(
      path.sep,
      'tmp',
      'project',
      '.texra',
      'skills',
    );
    const sources = defaultSkillSources(
      {
        cwd: path.resolve(path.sep, 'tmp', 'project'),
        resourcesPath: path.resolve(path.sep, 'tmp', 'resources'),
      },
      {
        additionalPaths: ['.texra/skills'],
      },
    );

    expect(
      sources.filter((source) => source.path === projectSkillsPath),
    ).toEqual([
      expect.objectContaining({
        scope: 'custom',
        label: 'custom',
        required: true,
      }),
    ]);
  });

  it('lists custom duplicate names before bundled skills', async () => {
    const resources = await makeTempDir('texra-cli-skills-', tempRoots);
    const custom = await makeTempDir('texra-cli-skills-', tempRoots);
    await fs.mkdir(path.join(resources, 'skills'));
    await writeSkill(
      path.join(resources, 'skills'),
      'shared-skill',
      'The bundled skill.',
    );
    await writeSkill(custom, 'shared-skill', 'The custom skill.');
    await writeSkill(custom, 'custom-only', 'The custom-only skill.');

    const result = await readCliSkills(
      {
        cwd: resources,
        resourcesPath: resources,
      },
      {
        additionalPaths: [custom],
      },
    );

    expect(result.skills.map(skillListRecord)).toMatchObject([
      {
        name: 'custom-only',
        description: 'The custom-only skill.',
        scope: 'custom',
      },
      {
        name: 'shared-skill',
        description: 'The custom skill.',
        scope: 'custom',
      },
    ]);
    const formatted = formatCliSkillList(result.skills);
    expect(formatted).toContain('custom\tshared-skill\tThe custom skill.');
    expect(formatted).not.toContain(
      'bundled\tshared-skill\tThe bundled skill.',
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_name',
        name: 'shared-skill',
      }),
    );
  });

  it('reports missing explicit custom skill sources', async () => {
    const result = await readCliSkills(
      {
        cwd: path.resolve(path.sep, 'tmp', 'project'),
        resourcesPath: path.resolve(path.sep, 'tmp', 'resources'),
      },
      {
        additionalPaths: ['missing-skills'],
      },
    );

    expect(result.skills).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'missing_source',
        path: path.resolve(path.sep, 'tmp', 'project', 'missing-skills'),
      }),
    );
  });

  it('reports explicit custom skill sources that are not directories', async () => {
    const root = await makeTempDir('texra-cli-skills-', tempRoots);
    const sourceFile = path.join(root, 'skills-file');
    await fs.writeFile(sourceFile, 'not a directory');

    const result = await readCliSkills(
      {
        cwd: root,
        resourcesPath: root,
      },
      {
        additionalPaths: [sourceFile],
      },
    );

    expect(result.skills).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'invalid_source',
        path: sourceFile,
      }),
    );
  });

  it('reads the runtime skill source registry used by prompt injection', async () => {
    const root = await makeTempDir('texra-cli-skills-', tempRoots);
    await writeSkill(root, 'proof-audit', 'Review mathematical proof steps.');
    setRuntimeSkillSources([
      {
        scope: 'project',
        path: root,
        label: 'project',
      },
    ]);

    const result = await readCliRuntimeSkills();

    expect(result.skills.map(skillListRecord)).toMatchObject([
      {
        name: 'proof-audit',
        description: 'Review mathematical proof steps.',
        scope: 'project',
        sourceLabel: 'project',
      },
    ]);
    expect(result.errors).toEqual([]);
  });
});
