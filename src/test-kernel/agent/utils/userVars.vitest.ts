// Third-party imports
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Standard library imports

// Local imports - agent components
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { setRuntimeSkillSources } from '@skills/runtimeSkills';
import { noopTrace } from '@agent/trace';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
// Type imports
import type {
  AgentSetting,
  AgentPrompt,
} from '@agent/core/definition/AgentDataclass';
// Internal imports
import { buildUserVars, getToolFlags } from '@agent/utils/userVars';

// getConfig reads through the platform config provider; drive the setting
// via this provider instead of patching the ESM export.
const fakeConfig = new FakeConfigProvider();

setupPlatform({}, { config: fakeConfig });

const baseSetting: AgentSetting = {
  agentCategory: AgentCategory.Workflow,
  temperature: 1,
  isRewrite: true,
  rounds: 1,
  requiredFiles: {},
  requiredFilesInternal: {},
  defaultOutputFiles: [],
  filePatternsContain: [],
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
  it('uses texra.debug.saveInputPrompt setting for PRINT_INPUT_PROMPT', async () => {
    try {
      fakeConfig.set('texra.debug.saveInputPrompt', true);
      const enabledFlags = getToolFlags(baseConfig, baseSetting, basePrompt);
      assert.equal(enabledFlags.PRINT_INPUT_PROMPT, true);

      fakeConfig.set('texra.debug.saveInputPrompt', false);
      const disabledFlags = getToolFlags(baseConfig, baseSetting, basePrompt);
      assert.equal(disabledFlags.PRINT_INPUT_PROMPT, false);
    } finally {
      await fakeConfig.update('texra.debug.saveInputPrompt', undefined);
    }
  });

  it('derives round count from additional userRequest entries', () => {
    const prompt: AgentPrompt = {
      ...basePrompt,
      userRequest: ['round0', 'reflect1', 'reflect2'],
    };
    const setting: AgentSetting = { ...baseSetting, rounds: 1 };

    const flags = getToolFlags(baseConfig, setting, prompt);
    assert.equal(flags.ROUNDS, 3);
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

  it('emits catalog load issues through the agent trace', async () => {
    const warn = vi.fn();
    const vars = await buildUserVars(
      baseConfig,
      { ...baseSetting, agentCategory: AgentCategory.ToolUse },
      basePrompt,
      '/agents/generic',
      { isOpenai: false, isAnthropic: false, isGoogle: false },
      { ...noopTrace, warn },
      { workspacePath: '/workspace' },
    );

    expect(vars.AVAILABLE_SKILLS).toBe('');
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `Skill import error: Skill source does not exist (${missingSource})`,
    );
  });
});
