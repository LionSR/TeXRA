/**
 * How a pending request reads wherever someone answers it: the progress
 * view's cards, the terminal's approval cards and the headless prompts. Each
 * kind's ask (what the agent wants, in one line) and its action words come
 * from here, so one request is not worded three ways. What an answer sends
 * is `REQUEST_ACTIONS`' (`@texra/shared/session/surfaceDecision`).
 */
import {
  REQUEST_ACTIONS,
  type RequestDecline,
} from '@texra/shared/session/surfaceDecision';
import { getModelLabel, type RequestPayload } from '@texra-ai/harness/schemas';

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

/** The label of the directory a command or a proposed agent runs in. */
export const WORKING_DIRECTORY_LABEL = 'Working directory';

/**
 * Each request's ask: the one line that says what the agent wants. A host
 * that marks up the object (a path in code, an agent in bold) puts it after
 * the words given here.
 */
export const REQUEST_ASK = Object.freeze({
  /** A host showing the directory inline adds `in <dir>`. */
  command: 'Run a command',
  /** The words before the edited file: `Edit draft.tex`. */
  edit: 'Edit',
  plan: 'Approve this plan',
  /** The words before the proposed agent: an agent launched on a task
   *  runs it; any other is delegated one. */
  proposal: (task: boolean): string => (task ? 'Run' : 'Delegate a task to'),
  /** A failed model call the user may retry, naming the model when known. */
  retry: (model: string | undefined): string =>
    model
      ? `The request to ${getModelLabel(model)} failed`
      : 'The model request failed',
});
