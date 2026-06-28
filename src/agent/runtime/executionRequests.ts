import {
  validateExecutionRequest,
  type ExecutionRequest,
  type ExecutionValidationResult,
  type ValidatedExecutionRequest,
} from '@agent/core/execution/executionRequests';
import {
  isWorkflowTaskState,
  isToolUseTaskState,
  TaskStateSchema,
  type TaskState,
  type ToolUseTaskState,
  type WorkflowTaskState,
} from '@agent/core/execution/TaskState';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { AgentCategory } from '@shared/schemas/agent';

import { getHelperModelName } from './helperModelName';

export type RuntimeAgentConfig = AgentConfig;
export type RuntimeAgentConfigPayload = AgentConfigPayload;
export type RuntimeAgentConfigPayloadWithoutCategory = Omit<
  RuntimeAgentConfigPayload,
  'agentCategory'
>;
export type RuntimeToolUseAgentConfigInput = Omit<
  RuntimeAgentConfigPayloadWithoutCategory,
  'model'
> & {
  readonly model?: RuntimeAgentConfigPayload['model'] | undefined;
};
export type RuntimeExecutionRequest = ExecutionRequest;
export type RuntimeValidatedExecutionRequest = ValidatedExecutionRequest;
export type RuntimeExecutionValidationResult = ExecutionValidationResult;
export type RuntimeTaskState = TaskState;
export type RuntimeWorkflowTaskState = WorkflowTaskState;
export type RuntimeToolUseTaskState = ToolUseTaskState;

export interface RuntimeMergeExecutionRequest {
  readonly baseFile: string;
  readonly editedFile: string;
  readonly model?: string;
}

export type RuntimeTaskStateBuildResult =
  | {
      readonly success: true;
      readonly config: RuntimeAgentConfig;
      readonly taskState: RuntimeTaskState;
    }
  | {
      readonly success: false;
      readonly issues: unknown;
    };

export interface RuntimeToolUseTaskStateFromWorkflowRequest {
  readonly taskState: RuntimeTaskState | undefined;
  readonly agent: string;
  readonly model: string;
  readonly instruction: string;
  readonly inputFiles?: readonly string[];
}

export type RuntimeToolUseTaskStateFromWorkflowResult =
  | {
      readonly success: true;
      readonly config: RuntimeAgentConfig;
      readonly taskState: RuntimeToolUseTaskState;
    }
  | {
      readonly success: false;
      readonly reason: 'missing_workflow_state';
    };

export function validateRuntimeExecutionRequest(
  request: RuntimeExecutionRequest,
): RuntimeExecutionValidationResult {
  return validateExecutionRequest(request);
}

export function buildRuntimeMergeExecutionRequest({
  baseFile,
  editedFile,
  model,
}: RuntimeMergeExecutionRequest): RuntimeExecutionValidationResult {
  return validateRuntimeExecutionRequest({
    config: {
      agent: 'merge',
      model: model ?? getHelperModelName(),
      inputFiles: [baseFile],
      editedFile,
    },
  });
}

export function parseRuntimeAgentConfig(config: unknown): RuntimeAgentConfig {
  return AgentConfigSchema.parse(config);
}

export function parseRuntimeToolUseAgentConfig(
  config: RuntimeToolUseAgentConfigInput,
): RuntimeAgentConfig {
  return parseRuntimeAgentConfig({
    ...config,
    agentCategory: AgentCategory.ToolUse,
  });
}

export function parseRuntimeTaskState(state: unknown): RuntimeTaskState {
  return TaskStateSchema.parse(state);
}

export function tryParseRuntimeTaskState(
  state: unknown,
): RuntimeTaskState | undefined {
  const result = TaskStateSchema.safeParse(state);
  return result.success ? result.data : undefined;
}

export function buildRuntimeTaskStateFromConfig(
  config: RuntimeAgentConfig,
): RuntimeTaskState {
  return agentConfigToTaskState(config);
}

export function buildRuntimeTaskStateFromConfigInput(
  config: unknown,
): RuntimeTaskStateBuildResult {
  const result = AgentConfigSchema.safeParse(config);
  if (!result.success) {
    return { success: false, issues: result.error.issues };
  }
  return {
    success: true,
    config: result.data,
    taskState: buildRuntimeTaskStateFromConfig(result.data),
  };
}

export function buildRuntimeToolUseTaskStateFromWorkflow({
  taskState,
  agent,
  model,
  instruction,
  inputFiles,
}: RuntimeToolUseTaskStateFromWorkflowRequest): RuntimeToolUseTaskStateFromWorkflowResult {
  if (!taskState || !isRuntimeWorkflowTaskState(taskState)) {
    return { success: false, reason: 'missing_workflow_state' };
  }

  const config = parseRuntimeToolUseAgentConfig({
    ...taskState.agentConfig,
    agent,
    model,
    instruction,
    ...(inputFiles && { inputFiles: [...inputFiles] }),
    outputFiles: [],
    editedFile: null,
    editedFiles: [],
  });
  const continuationState = buildRuntimeTaskStateFromConfig(config);
  if (!isRuntimeToolUseTaskState(continuationState)) {
    throw new Error(
      'Expected tool-use task state after runtime tool-use continuation construction.',
    );
  }
  return {
    success: true,
    config,
    taskState: continuationState,
  };
}

export function isRuntimeWorkflowTaskState(
  state: RuntimeTaskState,
): state is RuntimeWorkflowTaskState {
  return isWorkflowTaskState(state);
}

export function isRuntimeToolUseTaskState(
  state: RuntimeTaskState,
): state is RuntimeToolUseTaskState {
  return isToolUseTaskState(state);
}
