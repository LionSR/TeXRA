import { describe, expect, it } from 'vitest';

import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';
import { AgentCategory } from '@agent/core/AgentDataclass';

describe('MainViewExecutionController', () => {
  it('keeps missing selections explicit before schema prefaults apply', () => {
    expect(prepareMainViewExecutionRequest({ model: 'gpt-5.4' }).valid).toBe(
      false,
    );
    expect(prepareMainViewExecutionRequest({ agent: 'direct-agent' })).toEqual({
      valid: false,
      message:
        'Agent and model selection required. Please select both before running.',
    });
  });

  it('requires an input file for workflow runs', () => {
    expect(
      prepareMainViewExecutionRequest({
        agent: 'direct-agent',
        model: 'gpt-5.4',
      }),
    ).toEqual({
      valid: false,
      message: 'Please select an input file.',
      docsCommand: 'file-management',
    });
  });

  it('normalizes UI execution fields into an agent config request', () => {
    const result = prepareMainViewExecutionRequest({
      agent: 'direct-agent',
      model: 'gpt-5.4',
      inputFiles: ['paper/main.tex'],
      outputFiles: ['paper/revised.tex'],
      outputFilesActive: true,
      mediaFiles: ['diagram.png', null],
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.request.config).toMatchObject({
      agent: 'direct-agent',
      model: 'gpt-5.4',
      inputFiles: ['paper/main.tex'],
      outputFiles: ['paper/revised.tex'],
      agentCategory: AgentCategory.Workflow,
      mediaFiles: ['diagram.png'],
      editedFile: null,
    });
  });
});
