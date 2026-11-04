import {
  HARNESS_INSTRUCTION_KEY,
  type ProviderErrorClassification,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
  type RunEnd,
} from '@shared/schemas';

import { isDiskFullError } from './errorPredicates';
import { normalizeProviderError } from './sdkError/providerErrorFormat';

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
 * Classify agent execution errors for consistent runtime notification policy.
 *
 * Every kind is decided by a typed signal: an errno, or
 * the failure's classification (a missing key is model access's
 * `RouteUnavailable`, an overflowed window llm's verdict, either one as a
 * run recorded it).
 */
export function classifyAgentError(err: unknown): AgentErrorKind {
  const primary = primaryAgentError(err);
  if (isDiskFullError(primary)) return 'disk-full';
  const kind = normalizeProviderError(primary).classification?.kind;
  if (kind === 'missing-api-key' || kind === 'context-window') return kind;
  return 'unexpected';
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

/** Map a classified error to host guidance. */
export function agentErrorPresentation(error: {
  kind: AgentErrorKind;
  message: string;
  /** Docs page of a refusing request (`Rejected.docsPage`), surfaced
   *  beside the error so the host's dialog keeps the guide affordance. */
  docsPage?: string;
  /** The failure's classification, carried beside its message so a host
   *  may word the failure itself. */
  classification?: ProviderErrorClassification;
}): AgentErrorPresentation {
  const docs = error.docsPage ? { docsPage: error.docsPage } : {};
  const facts = error.classification
    ? { classification: error.classification }
    : {};
  switch (error.kind) {
    case 'missing-api-key':
      return {
        type: 'instruction',
        payload: {
          key: HARNESS_INSTRUCTION_KEY.MISSING_API_KEY,
          message: MISSING_API_KEY_MESSAGE,
          showSuppress: false,
        },
      };
    case 'context-window':
    case 'disk-full':
    case 'result-lost':
    case 'unexpected':
      return {
        type: 'error',
        payload: { message: error.message, ...docs, ...facts },
      };
    default: {
      // Every error kind must choose an explicit presentation policy.
      const unhandled: never = error.kind;
      return unhandled;
    }
  }
}
