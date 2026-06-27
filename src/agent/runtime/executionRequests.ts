import {
  validateExecutionRequest,
  type ExecutionRequest,
  type ExecutionValidationResult,
  type ValidatedExecutionRequest,
} from '@agent/core/execution/executionRequests';
import {
  isToolUseTaskState,
  TaskStateSchema,
  type TaskState,
} from '@agent/core/execution/TaskState';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';

export type RuntimeAgentConfig = AgentConfig;
export type RuntimeAgentConfigPayload = AgentConfigPayload;
export type RuntimeExecutionRequest = ExecutionRequest;
export type RuntimeValidatedExecutionRequest = ValidatedExecutionRequest;
export type RuntimeExecutionValidationResult = ExecutionValidationResult;
export type RuntimeTaskState = TaskState;

export function validateRuntimeExecutionRequest(
  request: RuntimeExecutionRequest,
): RuntimeExecutionValidationResult {
  return validateExecutionRequest(request);
}

export function parseRuntimeAgentConfig(config: unknown): RuntimeAgentConfig {
  return AgentConfigSchema.parse(config);
}

export function parseRuntimeTaskState(state: unknown): RuntimeTaskState {
  return TaskStateSchema.parse(state);
}

export function isRuntimeToolUseTaskState(state: RuntimeTaskState): boolean {
  return isToolUseTaskState(state);
}
