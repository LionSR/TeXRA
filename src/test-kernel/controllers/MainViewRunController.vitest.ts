import { describe, expect, it } from 'vitest';

import {
  prepareMainViewRunRequest,
  prepareMainViewTeamRunRequest,
} from '@controllers/mainView/MainViewRunController';
import { AgentCategory } from '@shared/schemas';

describe('MainViewRunController', () => {
  it('keeps missing selections explicit before schema prefaults apply', () => {
    expect(prepareMainViewRunRequest({ model: 'gpt-5.4' }).valid).toBe(
      false,
    );
    expect(prepareMainViewRunRequest({ agent: 'direct-agent' })).toEqual({
      valid: false,
      message: 'Choose an agent, a model, and a run type first.',
    });
    expect(
      prepareMainViewRunRequest({
        agent: 'direct-agent',
        model: 'gpt-5.4',
      }).valid,
    ).toBe(false);
  });

  it('requires an input file for workflow runs', () => {
    expect(
      prepareMainViewRunRequest({
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

  it('normalizes UI run fields into an agent config request', () => {
    const result = prepareMainViewRunRequest({
      agent: 'direct-agent',
      model: 'gpt-5.4',
      agentCategory: AgentCategory.Workflow,
      files: {
        inputFiles: ['paper/main.tex'],
        mediaFiles: ['diagram.png', null],
      },
      toolConfig: { attachTeXCount: true },
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
        attachTeXCount: true,
      },
    });
  });

  it('builds team requests from resolved fields and ignores the UI agent', () => {
    const result = prepareMainViewTeamRunRequest(
      {
        agent: 'stale-renderer-agent',
        model: 'gpt-5.4',
        session: { cli: { multiAgentPresetId: 'stale-preset' } },
      },
      {
        agent: 'builtInToolUse:lead',
        delegationAgentScope: {
          workflow: ['builtInWorkflow:writer'],
          toolUse: ['builtInToolUse:lead', 'builtInToolUse:member'],
        },
        cli: { multiAgentPresetId: 'custom-team' },
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
      cli: { multiAgentPresetId: 'custom-team' },
    });
  });

  it('requires a lead model but not a renderer agent for team requests', () => {
    const fields = {
      agent: 'builtInToolUse:lead',
      delegationAgentScope: {
        workflow: ['builtInWorkflow:writer'],
        toolUse: ['builtInToolUse:lead'],
      },
      cli: { multiAgentPresetId: 'custom-team' },
    };

    expect(
      prepareMainViewTeamRunRequest({ agent: 'ignored' }, fields).valid,
    ).toBe(false);
    expect(
      prepareMainViewTeamRunRequest({ model: 'gpt-5.4' }, fields).valid,
    ).toBe(true);
  });
});
