import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  AgentWorkflowSettingSchema,
  type AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import { AgentCategory } from '@shared/schemas';
import { noopTrace } from '@test/support/noopTrace';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { testRuntime } from '@test/support/testProcessRuntime';
import { spiedTrace } from '@test/support/spiedTrace';
import { installTestSkillRoots, writeSkill } from '@test/support/skillFixtures';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { FakeConfigProvider, fakePath } from '@test/support/FakePlatform';

/** The harness runtime supplies the standard-library filesystem prompt
 *  assembly reads through. */
const buildOpening = (...args: Parameters<typeof buildTemplateInputs>) =>
  testRuntime().runPromise(buildTemplateInputs(...args));

// getConfig reads through the platform config provider; drive the setting
// via this provider instead of patching the ESM export.
const fakeConfig = new FakeConfigProvider();
/** The launch's read of the installed plugins: none installed. */
const NO_INSTALLED_PLUGINS = Effect.succeed({ loadable: [], withheld: [] });

setupPlatform({}, { config: fakeConfig });

const baseSetting: AgentSetting = {
  agentCategory: AgentCategory.Workflow,
  temperature: 1,
  isRewrite: true,
  rounds: 1,
  requiredFilesInternal: {},
  defaultOutputFiles: [],
  tools: [],
};

const baseConfig: AgentConfig = AgentConfigSchema.parse({
  model: 'test',
  agent: 'agent',
  instruction: '',
  inputFile: 'input.tex',
});

describe('buildTemplateInputs runtime skill diagnostics', () => {
  const missingSource = fakePath('missing/runtime-skill-source');
  const tempRoots = useTempDirs();

  beforeEach(() => {
    fakeConfig.set('texra.skills.enabled', true);
    installTestSkillRoots([
      { tier: 'bundled', path: missingSource, required: true },
    ]);
  });

  afterEach(async () => {
    installTestSkillRoots([]);
    await Effect.runPromise(
      fakeConfig.update('texra.skills.enabled', undefined),
    );
  });

  it.effect('keeps skills off until the master switch is enabled', () =>
    Effect.gen(function* () {
      yield* fakeConfig.update('texra.skills.enabled', undefined);
      const warn = vi.fn();

      const opening = yield* Effect.promise(() =>
        buildOpening(
          baseConfig,
          { ...baseSetting, agentCategory: AgentCategory.ToolUse },
          fakePath('agents/generic'),
          false,
          spiedTrace({ warn }),
          {
            workspacePath: fakePath('workspace'),
            storageRoot: testWorkspaceRoots().storage,
            config: testWorkspaceRoots().config,
            settings: testWorkspaceRoots(),
            installed: NO_INSTALLED_PLUGINS,
          },
        ),
      );

      expect(opening.catalog).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    }),
  );

  it('emits catalog load issues through the agent trace', async () => {
    const warn = vi.fn();
    const opening = await buildOpening(
      baseConfig,
      { ...baseSetting, agentCategory: AgentCategory.ToolUse },
      fakePath('agents/generic'),
      false,
      spiedTrace({ warn }),
      {
        workspacePath: fakePath('workspace'),
        storageRoot: testWorkspaceRoots().storage,
        config: testWorkspaceRoots().config,
        settings: testWorkspaceRoots(),
        installed: NO_INSTALLED_PLUGINS,
      },
    );

    expect(opening.catalog).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `Skill import error: Skill source does not exist (${missingSource})`,
      { stageId: undefined },
    );
  });

  it('catalogs an accepted skill with the directory tools may read', async () => {
    const root = await makeTempDir('texra-user-vars-skills-', tempRoots);
    const rawDescription =
      'Use \u001b[31mcare\u001b[0m with clients/acme/private key.';
    await writeSkill(
      root,
      'client-review',
      { name: 'client-review', description: rawDescription },
      'Apply the skill.',
    );
    installTestSkillRoots([{ tier: 'project', path: root }]);

    const opening = await buildOpening(
      baseConfig,
      { ...baseSetting, agentCategory: AgentCategory.ToolUse },
      fakePath('agents/generic'),
      false,
      noopTrace,
      {
        workspacePath: fakePath('workspace'),
        storageRoot: testWorkspaceRoots().storage,
        config: testWorkspaceRoots().config,
        settings: testWorkspaceRoots(),
        installed: NO_INSTALLED_PLUGINS,
      },
    );

    expect(opening.catalog).toEqual([
      {
        plugin: null,
        name: 'client-review',
        text: expect.stringContaining('- client-review:'),
        directory: expect.stringContaining('client-review'),
      },
    ]);
  });
});

// The describes below replace the whole global platform in their own
// beforeEach and never restore it — they MUST stay the last describes in
// this file.
function buildVars(
  agentConfig: ReturnType<typeof AgentConfigSchema.parse>,
  requiredFilesInternal: Record<string, string> = {},
): ReturnType<typeof buildOpening> {
  const agentSetting = AgentWorkflowSettingSchema.parse({
    agentCategory: AgentCategory.Workflow,
    requiredFilesInternal,
  });
  return buildOpening(
    agentConfig,
    agentSetting,
    fakePath('agents/generic'),
    false,
    noopTrace,
    {
      workspacePath: fakePath('workspace'),
      storageRoot: testWorkspaceRoots().storage,
      config: testWorkspaceRoots().config,
      settings: testWorkspaceRoots(),
      installed: NO_INSTALLED_PLUGINS,
    },
  );
}

describe('buildTemplateInputs with missing configured files', () => {
  beforeEach(async () => {
    await installPlatform({
      workspacePath: fakePath('workspace'),
      files: {
        '/workspace/present.tex': 'present input',
        '/workspace/context.tex': 'present context',
        '/workspace/.texra/storage/memories/present.md':
          '---\nmodifiedBy: user\nmodifiedAt: 2026-06-20T14:30:45.123Z\n---\nRemember this convention.',
      },
    });
  });

  it('keeps prompt file metadata in sync with readable prompt XML', async () => {
    const { inputs: vars } = await buildVars(
      AgentConfigSchema.parse({
        agent: 'generic',
        model: 'test-model',
        inputFiles: ['missing.tex', 'present.tex'],
        contextFiles: ['missing-context.tex', 'context.tex'],
      }),
    );

    expect(vars.ALL_INPUTS).toBe(
      '<document name="present.tex">\npresent input\n</document>',
    );
    expect(vars.INPUT_FILES).toEqual(['present.tex']);
    expect(vars.LIST_OF_ALL_INPUTS).toBe('present.tex');
    expect(vars.INPUT_FILE).toBe('present.tex');
    expect(vars.INPUT_CONTENT).toBe('present input');

    expect(vars.ALL_CONTEXTS).toBe(
      '<document name="context.tex">\npresent context\n</document>',
    );
    expect(vars.CONTEXT_FILES).toEqual(['context.tex']);
    expect(vars.LIST_OF_ALL_CONTEXTS).toBe('context.tex');
    expect(vars.CONTEXT_FILE).toBe('context.tex');
    expect(vars.CONTEXT_CONTENT).toBe('present context');
  });

  it('records attached memory read misses from the prompt-load pass', async () => {
    const { inputs: vars, attachedMemoryMisses } = await buildVars(
      AgentConfigSchema.parse({
        agent: 'generic',
        model: 'test-model',
        memories: ['/memories/present.md', '/memories/missing.md'],
      }),
    );

    expect(vars.ATTACHED_MEMORIES).toBe(
      '<attached_memories>\n<memory name="/memories/present.md">\nRemember this convention.\n</memory>\n</attached_memories>',
    );
    expect(attachedMemoryMisses).toEqual([
      expect.objectContaining({ path: '/memories/missing.md' }),
    ]);
  });
});

describe('requiredFilesInternal custom variables', () => {
  const briefPath = fakePath('agents/generic', 'brief.txt');

  beforeEach(async () => {
    await installPlatform({
      workspacePath: fakePath('workspace'),
      files: { [briefPath]: 'briefing notes' },
    });
  });

  // A required file named after a file category generates the fixed X_FILE /
  // X_CONTENT variables and would silently override them. The guard fails
  // loudly at variable-build time instead.
  it.each(['INPUT', 'CONTEXT', 'EDITED', 'MEDIA'])(
    'rejects a required file named %s whose generated variables collide with the fixed vocabulary',
    async (varName) => {
      await expect(
        buildVars(
          AgentConfigSchema.parse({ agent: 'generic', model: 'test-model' }),
          { [varName]: 'brief.txt' },
        ),
      ).rejects.toThrow('collides with a fixed template variable');
    },
  );

  it('passes custom required-file variables through beside the fixed vocabulary', async () => {
    const { inputs: vars } = await buildVars(
      AgentConfigSchema.parse({ agent: 'generic', model: 'test-model' }),
      { BRIEF: 'brief.txt' },
    );

    expect(vars['BRIEF_FILE']).toBe(briefPath);
    expect(vars['BRIEF_CONTENT']).toBe('briefing notes');
    // The fixed slots the collision guard protects keep their built values.
    expect(vars.MEDIA_FILE).toBeNull();
    expect(vars.INSTRUCTION).toBe('');
  });
});
