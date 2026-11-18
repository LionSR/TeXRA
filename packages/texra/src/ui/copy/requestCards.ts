/**
 * How a pending request reads wherever someone answers it: the progress
 * view's cards and the terminal's approval cards. Each kind's action words
 * come from here, so one request is not worded two ways. What an answer
 * sends is `REQUEST_ACTIONS`' (`@texra/shared/session/surfaceDecision`).
 */
import {
  REQUEST_ACTIONS,
  type RequestDecline,
} from '@texra/shared/session/surfaceDecision';
import type { RequestPayload } from '@texra-ai/harness/schemas';

/** The primary answer's word, by what it sends; a kind answered from a
 *  form (a question) submits it. */
const PRIMARY_LABEL = Object.freeze({
  approve: 'Approve',
  retry: 'Retry',
} as const);

/** The decline's word, by how the kind declines. */
const DECLINE_LABEL = Object.freeze({
  reject: 'Reject',
  skip: 'Skip',
  stop: 'Stop task',
} as const satisfies Record<RequestDecline, string>);

/** The word on a `kind` request's primary action (its `y`). */
export function requestPrimaryLabel(kind: RequestPayload['kind']): string {
  const actions = REQUEST_ACTIONS[kind];
  return 'y' in actions ? PRIMARY_LABEL[actions.y.action] : 'Submit';
}

/** The word on a `kind` request's decline (its `n` and Esc). */
export function requestDeclineLabel(kind: RequestPayload['kind']): string {
  return DECLINE_LABEL[REQUEST_ACTIONS[kind].n];
}
