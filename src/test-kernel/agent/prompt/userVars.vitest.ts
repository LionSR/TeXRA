import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';

import { noopTrace } from '@agent/trace';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type {
  BuiltUserVars,
  TemplateVars,
} from '@agent/core/definition/AgentCycleOptions';
import {
  AgentPromptSchema,
  AgentWorkflowSettingSchema,
  type AgentPrompt,
  type AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import {
  buildUserVars,
  getToolFlags,
  resolveOutputFiles,
} from '@agent/prompt/userVars';
import { AgentCategory } from '@shared/schemas';
import { setRuntimeSkillSources } from '@skills/runtimeSkills';
import { setupPlatform } from '@test/support/setupPlatform';
import { spiedTrace } from '@test/support/spiedTrace';
import { writeSkill } from '@test/support/skillFixtures';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import {
  createFakePlatform,
  FakeConfigProvider,
} from '@test/support/FakePlatform';

// getConfig reads through the platform config provider; drive the setting
// via this provider instead of patching the ESM export.
const fakeConfig = new FakeConfigProvider();

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

const basePrompt: AgentPrompt = {
  systemPrompt: '',
  userPrefix: '',
  userRequest: '',
};

const baseConfig: AgentConfig = AgentConfigSchema.parse({
  model: 'test',
  agent: 'agent',
  instruction: '',
  inputFile: 'input.tex',
  toolConfig: {
    autoExtractFigure: false,
    autoExtractTikzFigure: false,
    attachTeXCount: false,
    autoCompileInputPdf: false,
  },
});

describe('getToolFlags', () => {
  it('uses texra.debug.saveModelIO setting for PRINT_INPUT_PROMPT', async () => {
    try {
      fakeConfig.set('texra.debug.saveModelIO', true);
      expect(
        getToolFlags(baseConfig, baseSetting, basePrompt).PRINT_INPUT_PROMPT,
      ).toBe(true);

      fakeConfig.set('texra.debug.saveModelIO', false);
      expect(
        getToolFlags(baseConfig, baseSetting, basePrompt).PRINT_INPUT_PROMPT,
      ).toBe(false);
    } finally {
      await fakeConfig.update('texra.debug.saveModelIO', undefined);
    }
  });

  it('derives round count from additional userRequest entries', () => {
    const prompt: AgentPrompt = {
      ...basePrompt,
      userRequest: ['round0', 'reflect1', 'reflect2'],
    };
    const setting: AgentSetting = { ...baseSetting, rounds: 1 };

    const flags = getToolFlags(baseConfig, setting, prompt);
    expect(flags.ROUNDS).toBe(3);
  });
});

describe('buildUserVars runtime skill diagnostics', () => {
  const missingSource = '/missing/runtime-skill-source';
  const tempRoots: string[] = [];

  beforeEach(() => {
    fakeConfig.set('texra.skills.enabled', true);
    setRuntimeSkillSources([
      {
        scope: 'bundled',
        path: missingSource,
        label: 'bundled',
        required: true,
      },
    ]);
  });

  afterEach(async () => {
    setRuntimeSkillSources([]);
    await fakeConfig.update('texra.skills.enabled', undefined);
    await cleanupTempDirs(tempRoots);
  });

  it('emits catalog load issues and the exact accepted snapshot through the agent trace', async () => {
    const warn = vi.fn();
    const emit = vi.fn();
    const vars = await buildUserVars(
      baseConfig,
      { ...baseSetting, agentCategory: AgentCategory.ToolUse },
      basePrompt,
      '/agents/generic',
      { isOpenai: false, isAnthropic: false, isGoogle: false },
      spiedTrace({ warn, emit }),
      { workspacePath: '/workspace' },
    );

    expect(vars.AVAILABLE_SKILLS).toBe('');
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `Skill import error: Skill source does not exist (${missingSource})`,
    );
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: 'skills.snapshot',
      skills: [],
    });
  });

  it('emits the raw accepted catalog without changing prompt membership', async () => {
    const root = await makeTempDir('texra-user-vars-skills-', tempRoots);
    const rawDescription =
      'Use \u001b[31mcare\u001b[0m with clients/acme/private key.';
    await writeSkill(
      root,
      'client-review',
      { name: 'client-review', description: rawDescription },
      'Apply the skill.',
    );
    setRuntimeSkillSources([{ scope: 'project', path: root }]);
    const emit = vi.fn();

    const vars = await buildUserVars(
      baseConfig,
      { ...baseSetting, agentCategory: AgentCategory.ToolUse },
      basePrompt,
      '/agents/generic',
      { isOpenai: false, isAnthropic: false, isGoogle: false },
      spiedTrace({ emit }),
      { workspacePath: '/workspace' },
    );

    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: 'skills.snapshot',
      skills: [
        {
          name: 'client-review',
          description: rawDescription,
          source: 'project',
        },
      ],
    });
    expect(vars.AVAILABLE_SKILLS).toContain('- client-review:');
  });

  it('does not publish a parent catalog for workflow runs', async () => {
    const emit = vi.fn();
    await buildUserVars(
      baseConfig,
      baseSetting,
      basePrompt,
      '/agents/generic',
      { isOpenai: false, isAnthropic: false, isGoogle: false },
      spiedTrace({ emit }),
      { workspacePath: '/workspace' },
    );

    expect(emit).not.toHaveBeenCalled();
  });
});

// Pure function: resolveOutputFiles takes plain data in, plain data out.
describe('output file prompt variables', () => {
  it.each([
    {
      name: 'exposes declared generated outputs without using an order variable',
      config: { outputFiles: ['main.tex', 'appendix.tex'] },
      setting: {},
      expectedVars: { OUTPUT_FILES: ['main.tex', 'appendix.tex'] },
      expectedOutputFiles: ['main.tex', 'appendix.tex'],
    },
    {
      name: 'falls back to default generated outputs',
      config: {},
      setting: { defaultOutputFiles: ['slides.tex'] },
      expectedVars: { OUTPUT_FILES: ['slides.tex'] },
      expectedOutputFiles: ['slides.tex'],
    },
    {
      name: 'leaves input-named outputs implicit',
      config: { inputFiles: ['main.tex', 'appendix.tex'], outputFiles: [] },
      setting: { defaultOutputFiles: [] },
      expectedVars: {},
      expectedOutputFiles: [],
    },
    {
      name: 'ignores stale output lists that only name selected inputs',
      config: {
        inputFiles: ['main.tex', 'appendix.tex'],
        outputFiles: ['appendix.tex'],
      },
      setting: { defaultOutputFiles: [] },
      expectedVars: {},
      expectedOutputFiles: [],
    },
  ])('$name', ({ config, setting, expectedVars, expectedOutputFiles }) => {
    const agentConfig = config as unknown as AgentConfig;
    const vars = resolveOutputFiles(
      agentConfig,
      setting as unknown as AgentSetting,
    );

    expect(vars).toEqual(expectedVars);
    expect(agentConfig.outputFiles).toEqual(expectedOutputFiles);
  });
});

// Compile-time pins for the buildUserVars contract: no runtime I/O, so this
// describe does not touch the platform.
describe('buildUserVars declared type', () => {
  it('admits custom required-file keys beside the precisely typed fixed vocabulary', () => {
    type BuiltResult = Awaited<ReturnType<typeof buildUserVars>>;

    expectTypeOf<BuiltResult>().toEqualTypeOf<BuiltUserVars>();
    // Fixed keys keep their precise types.
    expectTypeOf<BuiltUserVars['MEDIA_CONTENT']>().toEqualTypeOf<null>();
    expectTypeOf<BuiltUserVars['IS_OPENAI_MODEL']>().toEqualTypeOf<boolean>();
    expectTypeOf<BuiltUserVars['INPUT_FILES']>().toEqualTypeOf<string[]>();
    // Custom required-file keys are admitted beside the fixed vocabulary.
    expectTypeOf<BuiltUserVars['CUSTOM_CONTENT']>().toEqualTypeOf<unknown>();
    // The render/channel boundary accepts the builder's product as-is.
    expectTypeOf<BuiltUserVars>().toMatchTypeOf<TemplateVars>();
  });
});

// The describes below replace the whole global platform in their own
// beforeEach and never restore it — they MUST stay the last describes in
// this file.
function buildVars(
  agentConfig: ReturnType<typeof AgentConfigSchema.parse>,
  requiredFilesInternal: Record<string, string> = {},
): ReturnType<typeof buildUserVars> {
  const agentSetting = AgentWorkflowSettingSchema.parse({
    agentCategory: AgentCategory.Workflow,
    requiredFilesInternal,
  });
  const agentPrompt = AgentPromptSchema.parse({});
  return buildUserVars(
    agentConfig,
    agentSetting,
    agentPrompt,
    '/agents/generic',
    { isOpenai: false, isAnthropic: false, isGoogle: false },
    noopTrace,
    { workspacePath: '/workspace' },
  );
}

describe('buildUserVars with missing configured files', () => {
  beforeEach(async () => {
    const { initPlatform } = await import('@platform/platform');

    initPlatform(
      createFakePlatform({
        workspacePath: '/workspace',
        files: {
          '/workspace/present.tex': 'present input',
          '/workspace/context.tex': 'present context',
          '/workspace/.texra/storage/memories/present.md':
            '---\nmodifiedBy: user\nmodifiedAt: 2026-06-20T14:30:45.123Z\n---\nRemember this convention.',
        },
      }),
    );
  });

  it('keeps prompt file metadata in sync with readable prompt XML', async () => {
    const vars = await buildVars(
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

  it('returns every file variable at its empty default when no files are configured', async () => {
    const vars = await buildVars(
      AgentConfigSchema.parse({ agent: 'generic', model: 'test-model' }),
    );

    expect(vars).toMatchObject({
      INPUT_FILE: null,
      INPUT_CONTENT: null,
      CONTEXT_FILE: null,
      CONTEXT_CONTENT: null,
      EDITED_FILE: null,
      EDITED_CONTENT: null,
      INPUT_FILES: [],
      CONTEXT_FILES: [],
      EDITED_FILES: [],
      ALL_INPUTS: null,
      ALL_CONTEXTS: null,
      ALL_EDITEDS: null,
      LIST_OF_ALL_INPUTS: '',
      LIST_OF_ALL_CONTEXTS: '',
      LIST_OF_ALL_EDITEDS: '',
      MEDIA_FILE: null,
      MEDIA_CONTENT: null,
    });
  });

  it('records attached memory read misses from the prompt-load pass', async () => {
    const vars = await buildVars(
      AgentConfigSchema.parse({
        agent: 'generic',
        model: 'test-model',
        memories: ['/memories/present.md', '/memories/missing.md'],
      }),
    );

    expect(vars.ATTACHED_MEMORIES).toBe(
      '<attached_memories>\n<memory name="/memories/present.md">\nRemember this convention.\n</memory>\n</attached_memories>',
    );
    expect(vars.ATTACHED_MEMORY_MISSES).toEqual([
      expect.objectContaining({ path: '/memories/missing.md' }),
    ]);
  });
});

describe('requiredFilesInternal custom variables', () => {
  beforeEach(async () => {
    const { initPlatform } = await import('@platform/platform');

    initPlatform(
      createFakePlatform({
        workspacePath: '/workspace',
        files: { '/agents/generic/brief.txt': 'briefing notes' },
      }),
    );
  });

  // A required file named after a file category generates the fixed X_FILE /
  // X_CONTENT variables and would silently override them — and, for
  // validators like MEDIA_CONTENT's z.null(), produce checkpoints the
  // persisted channel schema rejects, making the session impossible to
  // resume. The guard fails loudly at variable-build time instead.
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

  it('names the offending generated key in the collision error', async () => {
    await expect(
      buildVars(
        AgentConfigSchema.parse({ agent: 'generic', model: 'test-model' }),
        { MEDIA: 'brief.txt' },
      ),
    ).rejects.toThrow(
      'requiredFilesInternal name "MEDIA" generates "MEDIA_FILE", which collides with a fixed template variable. Rename the required-file variable.',
    );
  });

  it('passes custom required-file variables through beside the fixed vocabulary', async () => {
    const vars = await buildVars(
      AgentConfigSchema.parse({ agent: 'generic', model: 'test-model' }),
      { BRIEF: 'brief.txt' },
    );

    expect(vars['BRIEF_FILE']).toBe('/agents/generic/brief.txt');
    expect(vars['BRIEF_CONTENT']).toBe('briefing notes');
    // The fixed slots the collision guard protects keep their built values.
    expect(vars.MEDIA_CONTENT).toBeNull();
    expect(vars.MODEL).toBe('test-model');
  });
});
