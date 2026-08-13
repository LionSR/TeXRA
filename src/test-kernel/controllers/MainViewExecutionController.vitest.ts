import { describe, expect, it } from 'vitest';

import {
  prepareMainViewExecutionRequest,
  prepareMainViewTeamExecutionRequest,
} from '@controllers/mainView/MainViewExecutionController';
import { AgentCategory } from '@shared/schemas';

describe('MainViewExecutionController', () => {
  it('keeps missing selections explicit before schema prefaults apply', () => {
    expect(prepareMainViewExecutionRequest({ model: 'gpt-5.4' }).valid).toBe(
      false,
    );
    expect(prepareMainViewExecutionRequest({ agent: 'direct-agent' })).toEqual({
      valid: false,
      message: 'Choose an agent, a model, and a run type first.',
    });
    expect(
      prepareMainViewExecutionRequest({
        agent: 'direct-agent',
        model: 'gpt-5.4',
      }).valid,
    ).toBe(false);
  });

  it('requires an input file for workflow runs', () => {
    expect(
      prepareMainViewExecutionRequest({
        agent: 'direct-agent',
        model: 'gpt-5.4',
        agentCategory: AgentCategory.Workflow,
      }),
    ).toEqual({
      valid: false,
      message: 'Choose an input file first.',
      docsCommand: 'file-management',
    });
  });

  it('normalizes UI execution fields into an agent config request', () => {
    const result = prepareMainViewExecutionRequest({
      agent: 'direct-agent',
      model: 'gpt-5.4',
      agentCategory: AgentCategory.Workflow,
      files: {
        inputFiles: ['paper/main.tex'],
        mediaFiles: ['diagram.png', null],
      },
      toolConfig: { attachDiagnostics: true },
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.request.config).toMatchObject({
      agent: 'direct-agent',
      model: 'gpt-5.4',
      inputFiles: ['paper/main.tex'],
      outputFiles: [],
      agentCategory: AgentCategory.Workflow,
      mediaFiles: ['diagram.png'],
      editedFile: null,
      toolConfig: {
        attachDiagnostics: false,
      },
    });
  });

  it('builds team requests from resolved fields and ignores the UI agent', () => {
    const result = prepareMainViewTeamExecutionRequest(
      {
        agent: 'stale-renderer-agent',
        model: 'gpt-5.4',
        session: { cliMultiAgentPresetId: 'stale-preset' },
      },
      {
        agent: 'builtInToolUse:lead',
        delegationAgentScope: {
          workflow: ['builtInWorkflow:writer'],
          toolUse: ['builtInToolUse:lead', 'builtInToolUse:member'],
        },
        cliMultiAgentPresetId: 'custom-team',
      },
    );

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.request.config).toMatchObject({
      agent: 'builtInToolUse:lead',
      model: 'gpt-5.4',
      agentCategory: AgentCategory.ToolUse,
      delegationAgentScope: {
        workflow: ['builtInWorkflow:writer'],
        toolUse: ['builtInToolUse:lead', 'builtInToolUse:member'],
      },
      cliMultiAgentPresetId: 'custom-team',
    });
  });

  it('requires a lead model but not a renderer agent for team requests', () => {
    const fields = {
      agent: 'builtInToolUse:lead',
      delegationAgentScope: {
        workflow: ['builtInWorkflow:writer'],
        toolUse: ['builtInToolUse:lead'],
      },
      cliMultiAgentPresetId: 'custom-team',
    };

    expect(
      prepareMainViewTeamExecutionRequest({ agent: 'ignored' }, fields).valid,
    ).toBe(false);
    expect(
      prepareMainViewTeamExecutionRequest({ model: 'gpt-5.4' }, fields).valid,
    ).toBe(true);
  });

  it('ignores stale UI output file selections', () => {
    const result = prepareMainViewExecutionRequest({
      agent: 'direct-agent',
      model: 'gpt-5.4',
      agentCategory: AgentCategory.Workflow,
      files: {
        inputFiles: ['paper/main.tex'],
        outputFiles: ['paper/old-output.tex'],
      },
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.request.config.outputFiles).toEqual([]);
  });
});
