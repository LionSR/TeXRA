import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cliSkillSources,
  formatCliSkillList,
  readCliSkills,
  skillListRecord,
} from '../../../packages/cli/src/runtime/skills';

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
  await Promise.all(
    tempRoots.splice(0).map((root) => {
      return fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe('CLI skills runtime', () => {
  it('resolves default, interop, and custom skill sources in precedence order', () => {
    const sources = cliSkillSources(
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
});
