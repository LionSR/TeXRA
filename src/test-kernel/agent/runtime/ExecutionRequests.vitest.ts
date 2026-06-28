import { afterEach, describe, expect, it, vi } from 'vitest';

const executionRequestsMock = vi.hoisted(() => ({
  validateExecutionRequest: vi.fn(),
}));

const helperModelNameMock = vi.hoisted(() => ({
  getHelperModelName: vi.fn(() => 'helper-default'),
}));

const taskStateMock = vi.hoisted(() => ({
  isToolUseTaskState: vi.fn(),
  isWorkflowTaskState: vi.fn(),
  TaskStateSchema: {
    parse: vi.fn((value: unknown) => value),
    safeParse: vi.fn((value: unknown): unknown => ({
      success: true,
      data: value,
    })),
  },
}));

const agentConfigMock = vi.hoisted(() => ({
  AgentConfigSchema: {
    parse: vi.fn((value: unknown) => value),
    safeParse: vi.fn((value: unknown): unknown => ({
      success: true,
      data: value,
    })),
  },
}));

vi.mock('@agent/core/execution/executionRequests', () => executionRequestsMock);
vi.mock('@agent/runtime/helperModelName', () => helperModelNameMock);
vi.mock('@agent/core/execution/TaskState', () => taskStateMock);
vi.mock('@agent/core/definition/AgentConfig', () => agentConfigMock);

import {
  buildRuntimeMergeExecutionRequest,
  buildRuntimeTaskStateFromConfig,
  buildRuntimeTaskStateFromConfigInput,
  getRuntimeDefaultMergeModelName,
  isRuntimeToolUseTaskState,
  isRuntimeWorkflowTaskState,
  parseRuntimeAgentConfig,
  parseRuntimeToolUseAgentConfig,
  parseRuntimeTaskState,
  tryParseRuntimeTaskState,
  type RuntimeAgentConfig,
  type RuntimeTaskState,
  validateRuntimeExecutionRequest,
} from '@agent/runtime/executionRequests';

describe('runtime execution requests', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('validates execution requests through the runtime boundary', () => {
    const validation = {
      valid: false,
      message: 'Invalid configuration (model): expected string',
    };
    executionRequestsMock.validateExecutionRequest.mockReturnValue(validation);

    const request = { config: { agent: 'proof', model: 'deepseekT' } };

    expect(validateRuntimeExecutionRequest(request)).toBe(validation);
    expect(executionRequestsMock.validateExecutionRequest).toHaveBeenCalledWith(
      request,
    );
  });

  it('builds merge execution requests with the helper-model default', () => {
    const validation = {
      valid: true,
      request: {
        config: {
          agent: 'merge',
          model: 'helper-default',
          inputFiles: ['/paper/main.tex'],
          editedFile: '/paper/main_revised.tex',
        },
      },
    };
    executionRequestsMock.validateExecutionRequest.mockReturnValue(validation);

    expect(
      buildRuntimeMergeExecutionRequest({
        baseFile: '/paper/main.tex',
        editedFile: '/paper/main_revised.tex',
      }),
    ).toBe(validation);

    expect(helperModelNameMock.getHelperModelName).toHaveBeenCalledOnce();
    expect(executionRequestsMock.validateExecutionRequest).toHaveBeenCalledWith(
      {
        config: {
          agent: 'merge',
          model: 'helper-default',
          inputFiles: ['/paper/main.tex'],
          editedFile: '/paper/main_revised.tex',
        },
      },
    );
  });

  it('honors explicit merge models without reading the helper-model default', () => {
    executionRequestsMock.validateExecutionRequest.mockReturnValue({
      valid: false,
      message: 'Invalid configuration (model): expected string',
    });

    buildRuntimeMergeExecutionRequest({
      baseFile: '/paper/main.tex',
      editedFile: '/paper/main_revised.tex',
      model: 'explicit-model',
    });

    expect(helperModelNameMock.getHelperModelName).not.toHaveBeenCalled();
    expect(executionRequestsMock.validateExecutionRequest).toHaveBeenCalledWith(
      {
        config: {
          agent: 'merge',
          model: 'explicit-model',
          inputFiles: ['/paper/main.tex'],
          editedFile: '/paper/main_revised.tex',
        },
      },
    );
  });

  it('exposes the runtime default merge model name', () => {
    expect(getRuntimeDefaultMergeModelName()).toBe('helper-default');

    expect(helperModelNameMock.getHelperModelName).toHaveBeenCalledOnce();
  });

  it('parses agent configs through the runtime boundary', () => {
    const config = {
      agent: 'proof',
      model: 'deepseekT',
      instruction: 'Check.',
    };

    expect(parseRuntimeAgentConfig(config)).toBe(config);
    expect(agentConfigMock.AgentConfigSchema.parse).toHaveBeenCalledWith(
      config,
    );
  });

  it('parses tool-use configs by owning the category stamp', () => {
    const config = {
      agent: 'changeReviewer',
      model: 'deepseekT',
      instruction: 'Review.',
    };

    parseRuntimeToolUseAgentConfig(config);

    expect(agentConfigMock.AgentConfigSchema.parse).toHaveBeenCalledWith({
      ...config,
      agentCategory: 'toolUse',
    });
  });

  it('parses and classifies task state through the runtime boundary', () => {
    const taskState = {
      agentConfig: { agentCategory: 'toolUse' },
    } as RuntimeTaskState;
    taskStateMock.isToolUseTaskState.mockReturnValue(true);
    taskStateMock.isWorkflowTaskState.mockReturnValue(false);

    expect(parseRuntimeTaskState(taskState)).toBe(taskState);
    expect(tryParseRuntimeTaskState(taskState)).toBe(taskState);
    expect(isRuntimeToolUseTaskState(taskState)).toBe(true);
    expect(isRuntimeWorkflowTaskState(taskState)).toBe(false);

    expect(taskStateMock.TaskStateSchema.parse).toHaveBeenCalledWith(taskState);
    expect(taskStateMock.TaskStateSchema.safeParse).toHaveBeenCalledWith(
      taskState,
    );
    expect(taskStateMock.isToolUseTaskState).toHaveBeenCalledWith(taskState);
    expect(taskStateMock.isWorkflowTaskState).toHaveBeenCalledWith(taskState);
  });

  it('returns undefined for invalid optional task state input', () => {
    const invalidState = { agentConfig: null };
    taskStateMock.TaskStateSchema.safeParse.mockReturnValueOnce({
      success: false,
      error: { issues: [{ message: 'invalid task state' }] },
    });

    expect(tryParseRuntimeTaskState(invalidState)).toBeUndefined();
    expect(taskStateMock.TaskStateSchema.safeParse).toHaveBeenCalledWith(
      invalidState,
    );
  });

  it('builds workflow and tool-use task states from runtime configs', () => {
    expect(
      buildRuntimeTaskStateFromConfig({
        agent: 'proof',
        model: 'deepseekT',
        agentCategory: 'workflow',
        inputFiles: ['main.tex'],
        contextFiles: [],
        mediaFiles: ['figure.png'],
        outputFiles: [],
      } as unknown as RuntimeAgentConfig),
    ).toEqual({
      agentConfig: expect.objectContaining({
        agent: 'proof',
        agentCategory: 'workflow',
      }),
      activeFiles: {
        input: true,
        context: false,
        media: true,
        output: false,
      },
    });

    expect(
      buildRuntimeTaskStateFromConfig({
        agent: 'chat',
        model: 'deepseekT',
        agentCategory: 'toolUse',
      } as unknown as RuntimeAgentConfig),
    ).toEqual({
      agentConfig: expect.objectContaining({
        agent: 'chat',
        agentCategory: 'toolUse',
      }),
      toolSessionState: {},
    });
  });

  it('builds task state from unknown config input and reports schema issues', () => {
    const config = {
      agent: 'proof',
      model: 'deepseekT',
      agentCategory: 'workflow',
      inputFiles: ['main.tex'],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: ['out.tex'],
    };

    expect(buildRuntimeTaskStateFromConfigInput(config)).toEqual({
      success: true,
      config,
      taskState: {
        agentConfig: expect.objectContaining({
          agent: 'proof',
          agentCategory: 'workflow',
        }),
        activeFiles: {
          input: true,
          context: false,
          media: false,
          output: true,
        },
      },
    });
    expect(agentConfigMock.AgentConfigSchema.safeParse).toHaveBeenCalledWith(
      config,
    );

    const issues = [{ path: ['agent'], message: 'missing agent' }];
    agentConfigMock.AgentConfigSchema.safeParse.mockReturnValueOnce({
      success: false,
      error: { issues },
    });

    expect(buildRuntimeTaskStateFromConfigInput({})).toEqual({
      success: false,
      issues,
    });
  });
});
