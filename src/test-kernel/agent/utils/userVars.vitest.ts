// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentWorkflowSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type {
  AgentSetting,
  AgentPrompt,
} from '@agent/core/definition/AgentDataclass';
import {
  buildUserVars,
  getToolFlags,
  resolveOutputFiles,
} from '@agent/utils/userVars';
import { setRuntimeSkillSources } from '@skills/runtimeSkills';
import { setupPlatform } from '@test/support/setupPlatform';
import { spiedTrace } from '@test/support/spiedTrace';
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
    attachDiagnostics: false,
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

// Folded from OutputFilesPrompt.vitest.ts (R7: one suite per module). This
// describe is a pure-function test (resolveOutputFiles takes plain data in,
// plain data out) and does not touch platform state, so it is safe to run in
// any position relative to the platform-dependent describes above/below.
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

// Folded from UserVarsMissingFiles.vitest.ts (R7: one suite per module).
// This describe replaces the whole global platform singleton in its own
// beforeEach (a from-scratch createFakePlatform, not the fakeConfig-backed
// platform the describes above rely on) and never restores it — it MUST stay
// the last describe in this file, or it would silently swap the platform out
// from under any suite that runs after it.
function buildVars(
  agentConfig: ReturnType<typeof AgentConfigSchema.parse>,
): ReturnType<typeof buildUserVars> {
  const agentSetting = AgentWorkflowSettingSchema.parse({
    agentCategory: AgentCategory.Workflow,
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
