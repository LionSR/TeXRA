import { Result, Schema, SchemaIssue } from 'effect';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigInput,
} from '@texra-ai/harness/schemas';

/** A fresh launch: a persisted run resumes through `resumeRun`. */
export interface RunRequest {
  config: AgentConfigInput;
}

export interface ValidatedRunRequest {
  config: AgentConfig;
}

type RunValidationResult =
  | { valid: true; request: ValidatedRunRequest }
  | { valid: false; message: string; issue?: SchemaIssue.Issue };

export function validateRunRequest(request: RunRequest): RunValidationResult {
  const parseResult = Schema.decodeUnknownResult(AgentConfigSchema)(
    request.config,
  );
  if (!Result.isSuccess(parseResult)) {
    const issue = parseResult.failure.issues[0];
    const errorPath = issue?.path.join('.') || 'unknown';
    return {
      valid: false,
      message: `Invalid configuration (${errorPath}): ${issue?.message ?? 'validation failed'}`,
      issue,
    };
  }

  return {
    valid: true,
    request: { config: parseResult.success },
  };
}
