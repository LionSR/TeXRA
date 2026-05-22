import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import {
  clearRuntimeSkillSources,
  loadRuntimeSkillCatalog,
  setRuntimeSkillSources,
} from '@skills/runtimeSkills';
import { buildInitialToolUsePrompts } from '@utils/prompt';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'texra-runtime-skills-'),
  );
  tempRoots.push(root);
  return root;
}

async function writeSkill(
  root: string,
  name: string,
  description: string,
): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name} when it applies.\n`,
  );
  return skillPath;
}

beforeEach(async () => {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(createFakePlatform({ workspacePath: '/workspace' }));
});

afterEach(async () => {
  clearRuntimeSkillSources();
  await Promise.all(
    tempRoots.splice(0).map((root) => {
      return fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe('runtime skills', () => {
  it('formats configured runtime skills for prompt injection', async () => {
    const root = await createTempRoot();
    const skillPath = await writeSkill(
      root,
      'manuscript-review',
      'Review mathematical manuscripts.',
    );
    setRuntimeSkillSources([
      { scope: 'project', path: root, label: 'project' },
    ]);

    const catalog = await loadRuntimeSkillCatalog();

    expect(catalog).toContain(
      '- manuscript-review: Review mathematical manuscripts.',
    );
    expect(catalog).toContain('Source: project');
    expect(catalog).toContain(`Path: ${skillPath}`);
  });

  it('injects the available skill catalog into tool-use instructions', async () => {
    const prompts = await buildInitialToolUsePrompts(
      {
        systemPrompt: 'System.',
        userPrefix: '',
        userRequest: 'Please help.',
      },
      {
        AVAILABLE_SKILLS:
          '- manuscript-review: Review mathematical manuscripts.\n  Source: project\n  Path: /tmp/project/.texra/skills/manuscript-review/SKILL.md',
      },
    );

    expect(prompts.instructionSuffix).toContain('<available_skills>');
    expect(prompts.instructionSuffix).toContain('manuscript-review');
    expect(prompts.instructionSuffix).toContain(
      'inspect its SKILL.md at the listed path',
    );
  });
});
