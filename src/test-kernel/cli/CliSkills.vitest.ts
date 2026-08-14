import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  formatCliSkillList,
  readCliRuntimeSkills,
  readCliSkills,
  skillListRecord,
} from '@cli/runtime/skills';
import { defaultSkillSources } from '@skills/skillSources';
import { setRuntimeSkillSources } from '@skills/runtimeSkills';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-skills-'));
  tempRoots.push(root);
  return root;
}

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

afterEach(async () => {
  setRuntimeSkillSources([]);
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('CLI skills runtime', () => {
  it('resolves default, interop, and custom skill sources in precedence order', () => {
    const cwd = path.resolve(path.sep, 'tmp', 'project');
    const resourcesPath = path.resolve(
      path.sep,
      'tmp',
      'repo',
      'packages',
      'cli',
      'dist',
      'resources',
    );
    const extensionBundledSourcePath = path.resolve(
      resourcesPath,
      '../../..',
      'skills',
    );
    const cliDistBundledSourcePath = path.resolve(
      resourcesPath,
      '../../../..',
      'skills',
    );
    const sources = defaultSkillSources(
      {
        cwd,
        resourcesPath,
      },
      {
        includeInterop: true,
        additionalPaths: ['vendor/skills'],
      },
    );

    expect(sources.map((source) => source.path)).toEqual([
      path.join(cwd, 'vendor', 'skills'),
      path.join(cwd, '.texra', 'skills'),
      path.join(cwd, '.agents', 'skills'),
      path.join(cwd, '.claude', 'skills'),
      path.join(cwd, '.codex', 'skills'),
      path.join(cwd, '.gemini', 'skills'),
      path.join(os.homedir(), '.texra', 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
      path.join(os.homedir(), '.claude', 'skills'),
      path.join(os.homedir(), '.codex', 'skills'),
      path.join(os.homedir(), '.gemini', 'skills'),
      path.join(resourcesPath, 'skills'),
      extensionBundledSourcePath,
      cliDistBundledSourcePath,
    ]);
    expect(sources.map((source) => source.scope)).toEqual([
      'custom',
      'project',
      'interop',
      'interop',
      'interop',
      'interop',
      'user',
      'interop',
      'interop',
      'interop',
      'interop',
      'bundled',
      'bundled',
      'bundled',
    ]);
    expect(sources.map((source) => source.label)).toEqual([
      'custom',
      'project',
      '.agents project',
      '.claude project',
      '.codex project',
      '.gemini project',
      'user',
      '.agents user',
      '.claude user',
      '.codex user',
      '.gemini user',
      'bundled',
      'bundled source',
      'bundled source',
    ]);
    expect(
      sources.find(
        (source) => source.path === path.join(cwd, 'vendor', 'skills'),
      ),
    ).toMatchObject({ required: true, scope: 'custom' });
  });

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
    const resources = await createTempRoot();
    const custom = await createTempRoot();
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

  it('lists project duplicate names before bundled skills', async () => {
    const project = await createTempRoot();
    const resources = await createTempRoot();
    await fs.mkdir(path.join(project, '.texra', 'skills'), {
      recursive: true,
    });
    await fs.mkdir(path.join(resources, 'skills'));
    await writeSkill(
      path.join(resources, 'skills'),
      'shared-skill',
      'The bundled skill.',
    );
    await writeSkill(
      path.join(project, '.texra', 'skills'),
      'shared-skill',
      'The project skill.',
    );

    const result = await readCliSkills({
      cwd: project,
      resourcesPath: resources,
    });

    expect(result.skills.map(skillListRecord)).toMatchObject([
      {
        name: 'shared-skill',
        description: 'The project skill.',
        scope: 'project',
      },
    ]);
    const formatted = formatCliSkillList(result.skills);
    expect(formatted).toContain('project\tshared-skill\tThe project skill.');
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
    const root = await createTempRoot();
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
    const root = await createTempRoot();
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
