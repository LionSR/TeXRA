import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { ProgressProposalOptionsController } from '@controllers/progressView/ProgressProposalOptionsController';
import type { RuntimeAgentOptionsData } from '@agent/runtime/agentResolution';
import { AgentCategory, type AgentProposalPermission } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

function workflowProposal(): AgentProposalPermission {
  return {
    proposalId: 'proposal-1',
    streamId: 'stream-1',
    agent: 'review',
    agentCategory: AgentCategory.Workflow,
    model: 'model',
    instruction: 'Check the proof.',
    memories: [],
    inputFiles: [],
    contextFiles: [],
    mediaFiles: [],
    outputFiles: [],
    toolConfig: DEFAULT_TOOL_CONFIG,
  };
}

function toolUseProposal(): AgentProposalPermission {
  return {
    proposalId: 'proposal-1',
    streamId: 'stream-1',
    agent: 'review',
    agentCategory: AgentCategory.ToolUse,
    model: 'model',
    instruction: 'Check the proof.',
    memories: [],
  };
}

function agentOptions(): RuntimeAgentOptionsData {
  return {
    workflow: [
      {
        value: 'builtInWorkflow:correct',
        label: 'Correct',
        isRemote: false,
      },
    ],
    toolUse: [
      {
        value: 'builtInToolUse:review',
        label: 'Review',
        isToolUse: true,
      },
    ],
  } as RuntimeAgentOptionsData;
}

describe('ProgressProposalOptionsController', () => {
  it('builds initial proposal options from the model fallback', () => {
    const controller = new ProgressProposalOptionsController({
      buildFallbackModelOptions: () => [{ value: 'basic', label: 'Basic' }],
    });

    assert.deepEqual(controller.getInitialOptions(), {
      modelOptionsData: [{ value: 'basic', label: 'Basic' }],
    });
  });

  it('maps workflow proposal agent options to plain-name values', async () => {
    const controller = new ProgressProposalOptionsController({
      loadModelOptions: async () => [{ value: 'model', label: 'Model' }],
      loadAgentOptions: async () => agentOptions(),
    });

    assert.deepEqual(await controller.buildOptions(workflowProposal()), {
      modelOptionsData: [{ value: 'model', label: 'Model' }],
      agentOptionsData: [
        {
          value: 'correct',
          label: 'Correct',
          isRemote: false,
        },
      ],
    });
  });

  it('maps tool-use proposal agent options to plain-name values', async () => {
    const controller = new ProgressProposalOptionsController({
      loadModelOptions: async () => [],
      loadAgentOptions: async () => agentOptions(),
    });

    assert.deepEqual(await controller.buildOptions(toolUseProposal()), {
      modelOptionsData: [],
      agentOptionsData: [
        {
          value: 'review',
          label: 'Review',
          isToolUse: true,
        },
      ],
    });
  });

  it('falls back for model options and omits unavailable agent options', async () => {
    const controller = new ProgressProposalOptionsController({
      loadModelOptions: async () => {
        throw new Error('model unavailable');
      },
      loadAgentOptions: async () => {
        throw new Error('agents unavailable');
      },
      buildFallbackModelOptions: () => [{ value: 'basic', label: 'Basic' }],
    });

    assert.deepEqual(await controller.buildOptions(toolUseProposal()), {
      modelOptionsData: [{ value: 'basic', label: 'Basic' }],
      agentOptionsData: undefined,
    });
  });
});
