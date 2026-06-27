import { afterEach, describe, expect, it, vi } from 'vitest';

const executionRequestsMock = vi.hoisted(() => ({
  validateExecutionRequest: vi.fn(),
}));

const taskStateMock = vi.hoisted(() => ({
  isToolUseTaskState: vi.fn(),
  TaskStateSchema: {
    parse: vi.fn((value: unknown) => value),
  },
}));

const agentConfigMock = vi.hoisted(() => ({
  AgentConfigSchema: {
    parse: vi.fn((value: unknown) => value),
  },
}));

vi.mock('@agent/core/execution/executionRequests', () => executionRequestsMock);
vi.mock('@agent/core/execution/TaskState', () => taskStateMock);
vi.mock('@agent/core/definition/AgentConfig', () => agentConfigMock);

import {
  isRuntimeToolUseTaskState,
  parseRuntimeAgentConfig,
  parseRuntimeTaskState,
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

  it('parses and classifies task state through the runtime boundary', () => {
    const taskState = {
      agentConfig: { agentCategory: 'toolUse' },
    } as RuntimeTaskState;
    taskStateMock.isToolUseTaskState.mockReturnValue(true);

    expect(parseRuntimeTaskState(taskState)).toBe(taskState);
    expect(isRuntimeToolUseTaskState(taskState)).toBe(true);

    expect(taskStateMock.TaskStateSchema.parse).toHaveBeenCalledWith(taskState);
    expect(taskStateMock.isToolUseTaskState).toHaveBeenCalledWith(taskState);
  });
});
