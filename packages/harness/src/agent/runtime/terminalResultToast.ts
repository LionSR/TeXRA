/**
 * The session's one terminal-failure presenter. Shared error guidance comes
 * from `agentErrorPresentation`. Child results and outcomes without error
 * metadata do not produce a notification.
 */
import { Effect, Predicate } from 'effect';

import type { ResultEvent } from '@agent/trace';
import {
  agentErrorPresentation,
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import {
  attachErrorPresentationClaimed,
  hasErrorPresentationClaimed,
} from '@common/errors/sdkError/errorMetadata';
import { Rejected } from '@shared/session/runtimeRequest';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { SessionHostInteractions } from './HostInteractions';
import type { SessionHandle } from './SessionHandle';

/** Whether a terminal result belongs to a child run: its attached parent,
 *  the view's, which has the run's `run.start` once it ended. */
function isChildResult(session: SessionHandle, event: ResultEvent): boolean {
  return session.view.run(event.runId)?.parentId != null;
}

/**
 * Present a classified failure on a host: its instruction (a missing API key)
 * or its error toast. An abort presents nothing. Replayed to a surface that
 * attaches later, so no guidance is lost for want of an attached host.
 */
function presentAgentFailure(
  interactions: Pick<SessionHostInteractions, 'emit'>,
  error: Parameters<typeof agentErrorPresentation>[0],
): Effect.Effect<void> {
  const toast = agentErrorPresentation(error);
  const options = { replayWhenAttached: true };
  if (toast?.type === 'instruction')
    return interactions.emit('requestShowInstruction', toast.payload, options);
  if (toast?.type === 'error')
    return interactions.emit('requestShowError', toast.payload, options);
  return Effect.void;
}

/**
 * Receipt for a root run's failure once its `run.end` row committed: the
 * session's presenter shows that row's guidance, so `failure`, what the run
 * throws past it, is marked presented. A run that never opened has no row:
 * its launch presents it (`Runs.launch`).
 */
export function receiveTerminalFailure(
  failure: Error,
  terminal: {
    readonly event: ResultEvent;
    readonly recorded: boolean;
  },
): void {
  const { error } = terminal.event;
  if (!terminal.recorded || !error) return;
  if (agentErrorPresentation(error) !== null)
    attachErrorPresentationClaimed(failure);
}

/**
 * The session's one terminal-result presenter, run for each `run.end` row the
 * session authored once its view has folded: a root run's failure goes to the
 * attached host or is replayed to the next one.
 */
export function presentTerminalResult(
  session: SessionHandle,
  event: ResultEvent,
): Effect.Effect<void> {
  return !event.error || isChildResult(session, event)
    ? Effect.void
    : presentAgentFailure(session.interactions, event.error);
}

/**
 * Present a failed run from its raw error: the primary failure, classified,
 * worded as `prefix` plus its text (a `Rejected` request's reason), and
 * replayed to a surface that attaches later, then marked presented. A
 * failure already presented (here, by the terminal-result presenter, or
 * through a targeted notice) presents nothing. A `Session` start's
 * `RunFailure` is presented as the failure it carries.
 */
export function presentRunFailure(
  interactions: Pick<SessionHostInteractions, 'emit'>,
  error: unknown,
  prefix = '',
): Effect.Effect<void> {
  if (hasErrorPresentationClaimed(error)) return Effect.void;
  attachErrorPresentationClaimed(error);
  const primary = primaryAgentError(
    Predicate.isTagged(error, 'RunFailure') && 'cause' in error
      ? error.cause
      : error,
  );
  const text =
    primary instanceof Rejected ? primary.reason : toErrorMessage(primary);
  return presentAgentFailure(interactions, {
    kind: classifyAgentError(primary),
    message: `${prefix}${text}`,
  });
}
