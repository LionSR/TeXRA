// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, AgentType, AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentPrompt } from '@agent/core/AgentDataclass';
import { getToolFlags } from '@agent/utils/userVars';
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
  userReflect: '',
};

const baseConfig: AgentConfig = {
  model: 'test',
  agent: 'agent',
  instruction: '',
  useMultipleOutputs: false,
  inputFile: 'input.tex',
  inputFiles: null,
  referenceFile: null,
  referenceFiles: null,
  auxiliaryFile: null,
  auxiliaryFiles: null,
  mediaFile: null,
  mediaFiles: null,
  outputFiles: null,
  editedFile: null,
  toolConfig: {
    autoExtractFigure: false,
    autoExtractTikzFigure: false,
    attachTeXCount: false,
    attachDiagnostics: false,
    autoCompileInputPdf: false,
  },
};

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
});
