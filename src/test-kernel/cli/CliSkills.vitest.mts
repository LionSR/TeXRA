import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillSources } from '@skills/skillSources';
import {
  clearRuntimeSkillSources,
  setRuntimeSkillSources,
} from '@skills/runtimeSkills';
import {
  formatCliSkillList,
  readCliRuntimeSkills,
  readCliSkills,
  skillListRecord,
} from '@cli/runtime/skills';

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
  clearRuntimeSkillSources();
  await Promise.all(
    tempRoots.splice(0).map((root) => {
      return fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe('CLI skills runtime', () => {
  it('resolves default, interop, and custom skill sources in precedence order', () => {
    const sources = defaultSkillSources(
      {
        cwd: '/tmp/project',
        resourcesPath: '/tmp/resources',
      },
      {
        includeInterop: true,
        additionalPaths: ['vendor/skills'],
      },
    );

    expect(sources.map((source) => source.path)).toEqual(
      expect.arrayContaining([
        '/tmp/resources/skills',
        path.join(os.homedir(), '.texra', 'skills'),
        '/tmp/project/.texra/skills',
        path.join(os.homedir(), '.claude', 'skills'),
        '/tmp/project/.claude/skills',
        path.join(os.homedir(), '.codex', 'skills'),
        '/tmp/project/.codex/skills',
        path.join(os.homedir(), '.gemini', 'skills'),
        '/tmp/project/.gemini/skills',
        '/tmp/project/vendor/skills',
      ]),
    );
    expect(
      sources.find((source) => source.path === '/tmp/project/vendor/skills'),
    ).toMatchObject({ required: true, scope: 'custom' });
  });

  it('lists bundled skills before custom duplicate names', async () => {
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
        name: 'shared-skill',
        description: 'The bundled skill.',
        scope: 'bundled',
      },
      {
        name: 'custom-only',
        description: 'The custom-only skill.',
        scope: 'custom',
      },
    ]);
    expect(formatCliSkillList(result.skills)).toContain(
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
        cwd: '/tmp/project',
        resourcesPath: '/tmp/resources',
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
        path: '/tmp/project/missing-skills',
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
