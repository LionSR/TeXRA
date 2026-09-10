import type { RunId } from '@shared/schemas';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigInput,
} from '../definition/AgentConfig';
import type { z } from 'zod';

export interface RunRequest {
  config: AgentConfigInput;
  executionId?: RunId;
}

export interface ValidatedRunRequest {
  config: AgentConfig;
  executionId?: RunId;
}

export type RunValidationResult =
  | { valid: true; request: ValidatedRunRequest }
  | { valid: false; message: string; issue?: z.ZodIssue };

export function validateRunRequest(request: RunRequest): RunValidationResult {
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
