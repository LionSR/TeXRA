import type { ExecutionId } from '@shared/schemas';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigInput,
} from '../definition/AgentConfig';

import type { z } from 'zod';

export interface ExecutionRequest {
  config: AgentConfigInput;
  executionId?: ExecutionId;
}

export interface ValidatedExecutionRequest {
  config: AgentConfig;
  executionId?: ExecutionId;
}

export type ExecutionValidationResult =
  | { valid: true; request: ValidatedExecutionRequest }
  | { valid: false; message: string; issue?: z.ZodIssue };

export function validateExecutionRequest(
  request: ExecutionRequest,
): ExecutionValidationResult {
  const parseResult = AgentConfigSchema.safeParse(request.config);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    const errorPath = issue?.path.join('.') || 'unknown';
    return {
      valid: false,
      message: `Invalid configuration (${errorPath}): ${issue?.message ?? 'validation failed'}`,
      issue,
    };
  }

  return {
    valid: true,
    request: {
      config: parseResult.data,
      executionId: request.executionId,
    },
  };
}
