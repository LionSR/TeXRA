/**
 * The child run an awaited `agent` call answers from, and the receipt a
 * detached one returns.
 *
 * A call's child is named by the call and its intent attempt
 * (`agentChildRunId`), so a resumed call finds what an earlier attempt
 * launched. The child's own aggregate says what became of it: `run.start` is
 * the launch, and a settled turn with a `run.result` manifest under its
 * `run.end` is its durable answer. A child a crash or a stop cut short is
 * resumed under its own id, not launched again; any other ended child's
 * end is the call's answer, which the model reads and decides on.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { deliveredOutput, getRunRecords } from '@agent/storage';
import { callChildRunId, readChildTurnState } from '@agent/storage/runRecords';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunServices } from '@agent/runtime/runRegistry';
import type { RunToolCall } from '@agent/runtime/RunCall';
import {
  RUN_OUTCOME,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';

// Local file imports
import { resumeSubagentInBand } from './inBandSubagentRun';

/** The child run one attempt of a call runs under, `call`'s own by
 *  default ({@link callChildRunId}). */
export const agentChildRunId = (
  call: RunToolCall,
  attempt = call.attempt,
): RunId =>
  callChildRunId({
    parentRunId: call.run.runId,
    responseId: call.responseId,
    callId: call.callId,
    attempt,
  });

/** The child the latest earlier attempt of this call launched, if any. */
export const earlierChild = Effect.fn('agent.earlierChild')(function* (
  call: RunToolCall,
): Effect.fn.Return<RunId | null, DatabaseReadFailed> {
  for (let earlier = call.attempt - 1; earlier >= 1; earlier -= 1) {
    const runId = agentChildRunId(call, earlier);
    if (yield* getRunRecords(call.run.session, runId).exists()) return runId;
  }
  return null;
});

/** What an existing child's rows say this call does with it. */
type ChildStanding =
  /** It ended after its work began: its end is the call's answer. */
  | { readonly kind: 'answered'; readonly result: RunEnd }
  /** Cut short by a crash or a stop: it continues under its own id. */
  | { readonly kind: 'resume' }
  /** It ended before any turn: nothing it did can be repeated. */
  | { readonly kind: 'fresh' };

const standingOf = Effect.fn('agent.childStanding')(function* (
  session: SessionHandle,
  runId: RunId,
): Effect.fn.Return<ChildStanding, DatabaseReadFailed> {
  const records = getRunRecords(session, runId);
  const end = yield* records.readRunEnd();
  const turns = yield* readChildTurnState(session, runId);
  // `childRunLoop` commits a turn's acceptance just before the turn runs:
  // one that never settled was cut short, and continues where it stopped.
  // A child with no end continues too: resuming one that settled its turn
  // re-parks, finishes at once with the answer its rows hold and settles,
  // with no model call and no tool run. Its own history decides about its
  // own unfinished calls.
  if (
    end === null ||
    (turns.active !== null && end.outcome !== RUN_OUTCOME.FAILED)
  )
    return { kind: 'resume' };
  const meta = yield* records.readResultMeta();
  const delivered = meta?.producer === 'subagent' ? meta : null;
  if (
    turns.active === null &&
    turns.lastCompleted === null &&
    delivered === null &&
    end.outcome !== RUN_OUTCOME.COMPLETED
  )
    return { kind: 'fresh' };
  // A completed child whose delivery manifest is missing has no answer to
  // read back: it is a failure that says so, not a completion with no
  // output.
  if (end.outcome === RUN_OUTCOME.COMPLETED && delivered === null)
    return {
      kind: 'answered',
      result: {
        ...end,
        outcome: RUN_OUTCOME.FAILED,
        error: {
          kind: 'unexpected',
          message:
            'The agent completed, but its result was not recorded. Its work may be done: check before calling it again.',
        },
      },
    };
  // Anything else ended: its end answers the call as it stands, a failure
  // included, and the model reads that answer and decides what follows.
  return {
    kind: 'answered',
    result:
      delivered !== null && end.outcome === RUN_OUTCOME.COMPLETED
        ? { ...end, output: deliveredOutput(delivered, end.output) }
        : end,
  };
});

/** What the child an earlier attempt of the call left settles it to. */
type Recovered =
  | {
      readonly kind: 'ended';
      readonly runId: RunId;
      readonly result: RunEnd;
    }
  /** No child answers the call: this attempt launches its own. */
  | { readonly kind: 'launch' };

/**
 * Settle a call from the child an earlier attempt of it left, before
 * anything about a launch is decided again: the child was approved and
 * configured when it launched. An ended child is read back, and one cut
 * short is resumed under its id.
 */
export const recoverAgentChild = Effect.fn('agent.recoverChild')(function* (
  call: RunToolCall,
  recovery: {
    /** Progress lines for the parent's trace. */
    readonly notify: (update: SubagentProgressUpdate) => void;
    /** Wraps the work this call runs now; not an answered child's read. */
    readonly running: <A, R>(
      work: Effect.Effect<A, Error, R>,
    ) => Effect.Effect<A, Error, R>;
  },
): Effect.fn.Return<Recovered, Error, AgentRunServices> {
  const { session, runId: parentRunId } = call.run;
  const earlier = yield* earlierChild(call);
  if (earlier === null) return { kind: 'launch' };
  const standing = yield* standingOf(session, earlier);
  switch (standing.kind) {
    case 'answered':
      return { kind: 'ended', runId: earlier, result: standing.result };
    case 'fresh':
      return { kind: 'launch' };
    case 'resume': {
      const { result } = yield* recovery.running(
        resumeSubagentInBand({
          session,
          runId: earlier,
          parentRunId,
          notify: recovery.notify,
        }),
      );
      return { kind: 'ended', runId: earlier, result };
    }
  }
});
