import {
  HARNESS_INSTRUCTION_KEY,
  toRetryErrorInfo,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
  type RunEnd,
} from '@shared/schemas';

import { isDiskFullError } from './errorPredicates';
import {
  DISK_FULL_MESSAGE,
  modelFailureIn,
  unexpectedMessage,
} from './sdkError/providerErrorFormat';

export type AgentErrorKind = NonNullable<RunEnd['error']>['kind'];

/**
 * Runtime aggregates put the primary failure first and retain later cleanup
 * failures for diagnostics. Follow that ordering through nested aggregates.
 */
export function primaryAgentError(err: unknown): unknown {
  while (err instanceof AggregateError) err = err.errors[0];
  return err;
}

/**
 * A run's failure as its `run.end` row records it. Every kind is decided by
 * a typed signal: an errno, or the model failure in the cause chain (as the
 * run recorded it, else llm's verdict or a missing route worded fresh);
 * anything else is unexpected, in its own words.
 */
export function classifyAgentError(err: unknown): NonNullable<RunEnd['error']> {
  const primary = primaryAgentError(err);
  if (isDiskFullError(primary))
    return { kind: 'disk-full', message: DISK_FULL_MESSAGE };
  const failure = modelFailureIn(primary);
  return failure === undefined
    ? { kind: 'unexpected', message: unexpectedMessage(primary) }
    : { kind: 'model', ...toRetryErrorInfo(failure) };
}

/** How a host presents an agent error: an instruction, or a plain error. */
export type AgentErrorPresentation =
  | {
      readonly type: 'instruction';
      readonly payload: RequestShowInstructionPayload;
    }
  | {
      readonly type: 'error';
      readonly payload: RequestShowErrorPayload;
    };

const MISSING_API_KEY_MESSAGE =
  'API key not found. Set your API key and run again.';

/**
 * Map a run's failure to host guidance: the missing-key instruction, or an
 * error with the failure's classification beside its message, which a host
 * may word in its place.
 */
export function agentErrorPresentation(
  error: NonNullable<RunEnd['error']>,
): AgentErrorPresentation {
  if (
    error.kind === 'model' &&
    error.classification?.kind === 'missing-api-key'
  )
    return {
      type: 'instruction',
      payload: {
        key: HARNESS_INSTRUCTION_KEY.MISSING_API_KEY,
        message: MISSING_API_KEY_MESSAGE,
        showSuppress: false,
      },
    };
  return {
    type: 'error',
    payload: {
      message: error.message,
      ...(error.kind === 'model' && error.classification !== undefined
        ? { classification: error.classification }
        : {}),
    },
  };
}
