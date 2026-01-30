// Local imports - agent configs
import type { AgentConfig } from '@agent/core/AgentConfig';

// Local imports - shared schemas
import type { ExecutionId } from '@shared/schemas';

export interface ExecutionRequest {
  config: AgentConfig;
  executionId?: ExecutionId;
}

export interface ExecutionValidationResult {
  ok: boolean;
  message?: string;
  action?: {
    label: string;
    command: string;
    args?: unknown[];
  };
}

interface ExecutionValidationInput {
  agent?: string;
  model?: string;
  inputFile?: string;
  isToolUse?: boolean;
}

export function buildExecutionRequest(
  config: AgentConfig,
  executionId?: ExecutionId,
): ExecutionRequest {
  return { config, executionId };
}

export function validateExecutionRequest(
  input: ExecutionValidationInput,
): ExecutionValidationResult {
  if (!input.agent || !input.model) {
    return {
      ok: false,
      message:
        'Agent and model selection required. Please select both before running.',
    };
  }

  if (!input.isToolUse && !input.inputFile) {
    return {
      ok: false,
      message: 'Please select an input file.',
      action: {
        label: 'File Management Guide',
        command: 'texra.openDoc',
        args: ['file-management'],
      },
    };
  }

  return { ok: true };
}
