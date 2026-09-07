import {
  INSTRUCTION_ACTION,
  RUN_OUTCOME,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
  type RunOutcome,
  type ResultEvent,
} from '@shared/schemas';

import { isDiskFullError } from './errorPredicates';
import { hasMissingApiKeyErrorMarker } from './sdkError/errorMetadata';
import { isContextWindowError, isUserAbort } from './sdkError/errorPatterns';

export type AgentErrorKind = NonNullable<ResultEvent['error']>['kind'];

/**
 * Canonical outcome of a run terminated by a thrown error, per error kind.
 * `abort` is the only cancellation — every other kind is a failure. Keep this
 * a declarative table so new kinds must take an explicit stance.
 */
export const AGENT_ERROR_OUTCOME: Readonly<Record<AgentErrorKind, RunOutcome>> =
  {
    abort: RUN_OUTCOME.CANCELLED,
    'context-window': RUN_OUTCOME.FAILED,
    'disk-full': RUN_OUTCOME.FAILED,
    'missing-api-key': RUN_OUTCOME.FAILED,
    unexpected: RUN_OUTCOME.FAILED,
  };

/**
 * Runtime aggregates put the primary failure first and retain later cleanup
 * failures for diagnostics. Follow that ordering through nested aggregates.
 */
export function primaryAgentError(err: unknown): unknown {
  while (err instanceof AggregateError) err = err.errors[0];
  return err;
}

/**
 * Classify agent execution errors for consistent runtime notification policy.
 *
 * Every kind is decided by a typed signal — an SDK/abort predicate, an errno,
 * or a `Symbol.for` marker attached at the throw site. Only
 * `isContextWindowError` still consults message text, and only for the
 * third-party providers whose SDKs expose no error code for the overflow.
 */
export function classifyAgentError(err: unknown): AgentErrorKind {
  const primary = primaryAgentError(err);
  if (isUserAbort(primary)) return 'abort';
  if (isDiskFullError(primary)) return 'disk-full';
  if (hasMissingApiKeyErrorMarker(primary)) return 'missing-api-key';
  if (isContextWindowError(primary)) return 'context-window';

  return 'unexpected';
}

type AgentErrorPresentation =
  | {
      readonly type: 'instruction';
      readonly payload: RequestShowInstructionPayload;
    }
  | {
      readonly type: 'error';
      readonly payload: RequestShowErrorPayload;
    };

const MISSING_API_KEY_MESSAGE =
  'API key not found. Set your API key in Settings and run again.';

/** Map a classified error to host guidance, with no notification for aborts. */
export function agentErrorPresentation(error: {
  kind: AgentErrorKind;
  message?: string;
}): AgentErrorPresentation | null {
  switch (error.kind) {
    case 'missing-api-key':
      return {
        type: 'instruction',
        payload: {
          key: 'missingApiKey',
          message: MISSING_API_KEY_MESSAGE,
          actions: [
            INSTRUCTION_ACTION.SET_API_KEY,
            INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE,
          ],
          showSuppress: false,
        },
      };
    case 'context-window':
      // A supplied message already carries the run's specific remediation.
      return {
        type: 'error',
        payload: {
          message:
            error.message ??
            'Conversation exceeds the model context window. Start a new ' +
              'session, or reduce attached files and tool output.',
        },
      };
    case 'disk-full':
      return {
        type: 'error',
        payload: { message: error.message ?? 'Disk full.' },
      };
    case 'unexpected':
      return {
        type: 'error',
        payload: {
          message: error.message ?? 'Unexpected error executing agent.',
        },
      };
    case 'abort':
      return null;
    default: {
      // Every error kind must choose an explicit presentation policy.
      const _exhaustive: never = error.kind;
      void _exhaustive;
      return null;
    }
  }
}
