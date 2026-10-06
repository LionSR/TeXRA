/**
 * The session's one terminal-failure presenter. Shared error guidance comes
 * from `agentErrorPresentation`. Child results and outcomes without error
 * metadata do not produce a notification.
 */
import { Effect, SubscriptionRef } from 'effect';

import type { ResultEvent } from '@agent/trace';
import {
  agentErrorPresentation,
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { causeChain } from '@common/errors/errorPredicates';
import { Rejected } from '@shared/session/requestErrors';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { SessionHostInteractions } from './HostInteractions';
import type { SessionHandle } from './SessionHandle';

/**
 * Whether a terminal result belongs to a child run: the handle's parent edge
 * while the run is tracked (a result is emitted before untrack), else the
 * fold's, which has the run's `run.start` for a launch that failed before a
 * handle existed.
 */
function isChildResult(session: SessionHandle, event: ResultEvent): boolean {
  const handle = session.runs.getHandle(event.runId);
  if (handle) return handle.parent !== null;
  const run = SubscriptionRef.getUnsafe(session.view.ref).runs.get(event.runId);
  return run !== undefined && run.parentId !== null;
}

/**
 * Present a classified failure on a host: its instruction (a missing API key)
 * or its error toast. An abort presents nothing. Replayed to a surface that
 * attaches later, so no guidance is lost for want of an attached host.
 */
function presentAgentFailure(
  interactions: SessionHostInteractions,
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

/** The failures {@link presentTerminalResult} took: its receipts, held by
 *  the error a run throws, so they go when that error does. */
const presentedFailures = new WeakSet<object>();

/**
 * Receipt for a root run's failure once its `run.end` row committed: the
 * session's presenter shows that row's guidance, or queues it for the next
 * surface, whenever it has any. `failure` is what the run throws past the
 * row, so no caller presents it a second time.
 */
export function receiveTerminalFailure(
  failure: Error,
  terminal: { readonly event: ResultEvent; readonly persistFailure?: unknown },
): void {
  const { error } = terminal.event;
  if (terminal.persistFailure !== undefined || !error) return;
  if (agentErrorPresentation(error) !== null) presentedFailures.add(failure);
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

/** Whether the terminal-result presenter took this failure (or one it
 *  wraps): the receipt a caller's own fallback reads. */
export function terminalFailurePresented(error: unknown): boolean {
  return causeChain(error).some((current) =>
    presentedFailures.has(current as object),
  );
}

/**
 * Present a failed run from its raw error: the primary failure, classified,
 * worded as `prefix` plus its text (a `Rejected` request's reason), and
 * replayed to a surface that attaches later. A failure the terminal-result
 * presenter took presents nothing here.
 */
export function presentRunFailure(
  interactions: SessionHostInteractions,
  error: unknown,
  prefix = '',
): Effect.Effect<void> {
  if (terminalFailurePresented(error)) return Effect.void;
  const primary = primaryAgentError(error);
  const text =
    primary instanceof Rejected ? primary.reason : toErrorMessage(primary);
  return presentAgentFailure(interactions, {
    kind: classifyAgentError(primary),
    message: `${prefix}${text}`,
  });
}
