// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent components
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentType,
  AgentCategory,
} from '@agent/core/AgentDataclass';
// Type imports
import type { AgentPrompt } from '@agent/core/AgentDataclass';
// Internal imports
import { buildUserVars, getToolFlags } from '@agent/utils/userVars';
import * as configModule from '@utils/config';

const baseSetting: AgentSetting = {
  agentType: AgentType.CoT,
  agentCategory: AgentCategory.Workflow,
  documentTag: 'document',
  temperature: 0,
  isRewrite: true,
  rounds: 1,
  prefills: [],
  outputExt: 'tex',
  endTag: '</latex_document>',
  requiredFiles: {},
  requiredFilesInternal: {},
  defaultOutputFiles: [],
  isMultipleOutput: false,
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
  useMultipleOutputs: false,
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
  it('uses texra.debug.saveInputPrompt setting for PRINT_INPUT_PROMPT', () => {
    const originalGetConfig = configModule.getConfig;

    try {
      (configModule as any).getConfig = (
        path: string,
        defaultValue?: unknown,
      ) => {
        if (path === 'debug.saveInputPrompt') {
          return true;
        }
        return defaultValue as unknown;
      };

      const enabledFlags = getToolFlags(baseConfig, baseSetting, basePrompt);
      assert.equal(enabledFlags.PRINT_INPUT_PROMPT, true);

      (configModule as any).getConfig = (
        path: string,
        defaultValue?: unknown,
      ) => {
        if (path === 'debug.saveInputPrompt') {
          return false;
        }
        return defaultValue as unknown;
      };

      const disabledFlags = getToolFlags(baseConfig, baseSetting, basePrompt);
      assert.equal(disabledFlags.PRINT_INPUT_PROMPT, false);
    } finally {
      (configModule as any).getConfig = originalGetConfig;
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
