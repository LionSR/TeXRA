import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import { buildInitialToolUsePrompts } from '@agent/prompt/PromptBuilder';
import {
  ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS,
  MESSAGE_TYPES,
} from '@shared/schemas';
import {
  formatRuntimeSkillActivation,
  loadRuntimeSkillCatalog,
  setRuntimeSkillSources,
} from '@skills/runtimeSkills';
import { setupPlatform } from '@test/support/setupPlatform';
import { writeSkill } from '@test/support/skillFixtures';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { attachTranscriptRecorder } from '@transcript/TexraTranscriptRecorder';
import { StreamLogStore } from '@transcript/StreamLogStore';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  return makeTempDir('texra-runtime-skills-', tempRoots);
}

setupPlatform({ workspacePath: '/workspace' });

afterEach(async () => {
  setRuntimeSkillSources([]);
  await cleanupTempDirs(tempRoots);
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
        frontmatter: {
          name: 'proof-audit',
          description: 'Review mathematical proof steps.',
        },
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
    setRuntimeSkillSources([
      { scope: 'project', path: root, label: 'project' },
    ]);

    const result = await loadRuntimeSkillCatalog();

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

  it('sanitizes the accepted summary before prompt-boundary emission', async () => {
    const root = await createTempRoot();
    await writeSkill(
      root,
      'safe-summary',
      {
        name: 'safe-summary',
        description:
          'Use \u001b[31mcare\u001b[0m with C:\\Users\\Jane Doe\\secret.tex and ./private/key.pem.',
      },
      'Apply the skill.',
    );
    setRuntimeSkillSources([{ scope: 'project', path: root }]);

    const result = await loadRuntimeSkillCatalog();

    expect(result.skills).toStrictEqual([
      {
        name: 'safe-summary',
        description: 'Details available on activation.',
        source: 'project',
      },
    ]);
  });

  it('keeps ANSI-only and controls-only skills with safe fallback summaries', async () => {
    const root = await createTempRoot();
    const descriptions = [
      ['ansi-only', '"\\u001b[31m\\u001b[0m"'],
      ['controls-only', '"\\u0001\\u0002\\u007f\\u009b"'],
    ] as const;
    for (const [name, description] of descriptions) {
      const skillDir = path.join(root, name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n\nApply the skill.\n`,
      );
    }
    setRuntimeSkillSources([{ scope: 'project', path: root }]);

    const result = await loadRuntimeSkillCatalog();

    expect(result.skills).toStrictEqual([
      {
        name: 'ansi-only',
        description: 'Details available on activation.',
        source: 'project',
      },
      {
        name: 'controls-only',
        description: 'Details available on activation.',
        source: 'project',
      },
    ]);
    expect(
      [...result.catalog.matchAll(/^- ([^:]+):/gm)].map((match) => match[1]),
    ).toStrictEqual(result.skills.map((skill) => skill.name));
  });

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
    setRuntimeSkillSources([{ scope: 'project', path: root }]);

    const result = await loadRuntimeSkillCatalog();
    const catalogNames = [...result.catalog.matchAll(/^- ([^:]+):/gm)].map(
      (match) => match[1],
    );
    const snapshotNames = result.skills.map((skill) => skill.name);

    expect(snapshotNames).toHaveLength(ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS);
    expect(catalogNames).toStrictEqual(snapshotNames);
    expect(snapshotNames.at(-1)).toBe('skill-199');
    expect(result.catalog).not.toContain('skill-200');

    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('bounded-skills');
    const streamId = 'stream:bounded-skills';
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    expect(() =>
      trace.emit({ type: 'skills.snapshot', skills: result.skills }),
    ).not.toThrow();
    expect(
      store
        .get(streamId)
        ?.getRange(0)
        .find((entry) => entry.messageType === MESSAGE_TYPES.ACTIVE_SKILLS)
        ?.data,
    ).toStrictEqual({ skills: result.skills });
  });

  it('returns structured issues when a required source is unavailable', async () => {
    const root = path.join(os.tmpdir(), 'texra-missing-runtime-skill-source');
    await fs.rm(root, { recursive: true, force: true });
    setRuntimeSkillSources([
      { scope: 'bundled', path: root, label: 'bundled', required: true },
    ]);

    const result = await loadRuntimeSkillCatalog();

    expect(result).toEqual({
      catalog: '',
      skills: [],
      issues: [
        {
          severity: 'error',
          code: 'missing_source',
          message: 'Skill source does not exist',
          path: root,
        },
      ],
    });
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
