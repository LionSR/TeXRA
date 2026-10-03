/**
 * The child run an awaited `agent` call answers from, and the receipt a
 * detached one returns.
 *
 * A call's child is named by the call and its intent attempt
 * (`agentChildRunId`), so a resumed call finds what an earlier attempt
 * launched. The child's own aggregate says what became of it: `run.start` is
 * the launch, and a settled turn with a `run.result` manifest under its
 * `run.end` is its durable answer. A child a crash or a stop cut short is
 * resumed under its own id, not launched again; one whose rows leave its
 * work unaccounted for is asked about, bound to the call, instead of being
 * repeated blindly.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { deliveredOutput, getRunRecords } from '@agent/storage';
import { readChildTurnState } from '@agent/storage/runRecords';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunServices } from '@agent/runtime/runRegistry';
import {
  RUN_OUTCOME,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import { configureDelegatedChildApprovals } from '@tools/approval';
import type { RunToolCall } from '@tools/core/toolRun';
import { deriveRunId } from '@utils/core/idHash';

// Local file imports
import { resumeSubagentInBand } from './inBandSubagentRun';

/**
 * The child run one attempt of a call runs under, `call`'s own by default.
 * A provider's call ids are unique within one response only, so the call is
 * named by its response too.
 */
export const agentChildRunId = (
  call: RunToolCall,
  attempt = call.attempt ?? 1,
): RunId =>
  deriveRunId({
    parentRunId: call.run.runId,
    responseId: call.responseId ?? '',
    callId: call.toolCallId ?? call.run.runId,
    attempt,
  });

/** The child the latest earlier attempt of this call launched, if any. */
export const earlierChild = Effect.fn('agent.earlierChild')(function* (
  call: RunToolCall,
): Effect.fn.Return<RunId | null, DatabaseReadFailed> {
  for (let earlier = (call.attempt ?? 1) - 1; earlier >= 1; earlier -= 1) {
    const runId = agentChildRunId(call, earlier);
    if (yield* getRunRecords(call.run.session, runId).exists()) return runId;
  }
  return null;
});

/** What an existing child's rows say this call does with it. */
type ChildStanding =
  /** Its turn settled and its manifest landed: its answer is the call's. */
  | { readonly kind: 'answered'; readonly result: RunEnd }
  /** Cut short by a crash or a stop: it continues under its own id. */
  | { readonly kind: 'resume' }
  /** It ended before any turn: nothing it did can be repeated. */
  | { readonly kind: 'fresh' }
  /** Its rows leave work unaccounted for. */
  | { readonly kind: 'unknown'; readonly reason: string };

const standingOf = Effect.fn('agent.childStanding')(function* (
  session: SessionHandle,
  runId: RunId,
): Effect.fn.Return<ChildStanding, DatabaseReadFailed> {
  const records = getRunRecords(session, runId);
  const end = yield* records.readRunEnd();
  if (end?.error?.kind === 'artifact-drain')
    return { kind: 'unknown', reason: 'its final artifacts never committed' };
  const turns = yield* readChildTurnState(session, runId);
  const meta = yield* records.readResultMeta();
  const delivered = meta?.producer === 'subagent' ? meta : null;
  if (turns.active !== null) {
    // `childRunLoop` commits a turn's acceptance just before the turn runs:
    // one that never settled was cut short, and continues where it stopped.
    if (end === null || end.outcome === RUN_OUTCOME.CANCELLED)
      return { kind: 'resume' };
    return {
      kind: 'unknown',
      reason: 'it ended without settling the turn it had started',
    };
  }
  if (turns.lastCompleted !== null) {
    // The manifest says the delivery landed, the row what it landed as.
    if (delivered === null || end === null)
      return {
        kind: 'unknown',
        reason: `it settled its turn but its ${delivered === null ? 'result' : 'outcome'} is missing`,
      };
    return {
      kind: 'answered',
      result:
        end.outcome === RUN_OUTCOME.COMPLETED
          ? { ...end, output: deliveredOutput(delivered, end.output) }
          : end,
    };
  }
  if (delivered !== null)
    return {
      kind: 'unknown',
      reason: 'it delivered a result but never settled its turn',
    };
  if (end === null) return { kind: 'resume' };
  if (end.outcome === RUN_OUTCOME.COMPLETED)
    return { kind: 'unknown', reason: 'it completed without a result' };
  return { kind: 'fresh' };
});

/** What the child an earlier attempt of the call left settles it to. */
type Recovered =
  | {
      readonly kind: 'ended';
      readonly runId: RunId;
      readonly result: RunEnd;
    }
  /** A person chose to skip a call whose child's outcome is unknown. */
  | { readonly kind: 'unknown'; readonly runId: RunId; readonly reason: string }
  /** No child answers the call: this attempt launches its own. */
  | { readonly kind: 'launch' };

/**
 * Settle a call from the child an earlier attempt of it left, before
 * anything about a launch is decided again: the child was approved and
 * configured when it launched. An answered child is read back, one cut
 * short is resumed under its id, and one whose work is unaccounted for is
 * asked about, the question bound to the call so it outlives a restart.
 */
export const recoverAgentChild = Effect.fn('agent.recoverChild')(function* (
  call: RunToolCall,
  recovery: {
    readonly agentName: string;
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
      // Its approvals follow the parent's live ones, as at its launch.
      const inherit = (runId: RunId): void =>
        configureDelegatedChildApprovals(
          runId,
          parentRunId,
          'inherit',
          session,
        );
      inherit(earlier);
      const { result } = yield* recovery.running(
        resumeSubagentInBand({
          session,
          runId: earlier,
          parentRunId,
          notify: recovery.notify,
          onRunResolved: inherit,
        }),
      );
      return { kind: 'ended', runId: earlier, result };
    }
    case 'unknown': {
      const { requests } = call;
      const decision = yield* requests.open({
        kind: 'toolOutcome',
        data: {
          requestId: requests.nextId('agent-outcome'),
          runId: parentRunId,
          toolName: 'agent',
          title: `'${recovery.agentName}' may have done work no result records: ${standing.reason}`,
          childRunId: earlier,
        },
      });
      return decision.action === 'retry'
        ? { kind: 'launch' }
        : { kind: 'unknown', runId: earlier, reason: standing.reason };
    }
  }
});
