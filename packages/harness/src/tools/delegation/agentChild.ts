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
 *
 * A script's awaited call may also be answered by a completed call before
 * it with the same prompt, options and file bytes (`reusable`).
 */

// Node imports
import { createHash } from 'node:crypto';

// Third-party imports
import { Effect, FileSystem } from 'effect';
import type { AgentRunServices } from '@agent/runtime/runRegistry';

// Local imports
import {
  getRunRecords,
  callChildRunId,
  readChildTurnState,
} from '@agent/storage/runRecords';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunToolCall, ScriptScope } from '@agent/runtime/RunCall';
import {
  qualifyAggregateId,
  RUN_OUTCOME,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
  type ToolResult,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import { errorResult } from '@tools/core/result';

// Local file imports
import { resumeSubagentInBand } from './inBandSubagentRun';

/** Most children one script may launch, by `agent()` and `self()` together. */
const AGENT_CALL_LIMIT = 1000;

/**
 * Counts the child `script` is about to launch, or returns the error result
 * once it has launched `AGENT_CALL_LIMIT`. Called just before a launch: a
 * reused, recovered or rejected call launches none, and a resume's replayed
 * calls never reach it.
 */
export const countLaunch = (
  script: ScriptScope,
  name: string,
): Effect.Effect<ToolResult | null> =>
  Effect.map(
    script.shared(
      'agent:launches',
      Effect.sync(() => ({ count: 0 })),
    ),
    (launches) => {
      if (launches.count >= AGENT_CALL_LIMIT)
        return errorResult(
          `A script may launch at most ${AGENT_CALL_LIMIT} agents; '${name}' did not run.`,
          { name: 'CallLimit' },
        );
      launches.count += 1;
      return null;
    },
  );

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
        ? { ...end, output: { ...end.output, ...delivered.output } }
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

/** The bytes behind a workflow call's files, hashed for its reuse key. */
export const fingerprint = Effect.fn('agent.fingerprint')(function* (
  paths: readonly (readonly string[])[],
) {
  const fs = yield* FileSystem.FileSystem;
  const hash = createHash('sha256');
  for (const [group, files] of paths.entries())
    for (const [index, file] of files.entries()) {
      const bytes = yield* fs.readFile(file);
      hash.update(`${group}\0${index}\0${bytes.length}\0`);
      hash.update(bytes);
    }
  return hash.digest('hex');
});

/**
 * The runs whose completed calls a call may reuse: the run that issued
 * the `script` call, and the background script runs it launched. A call of
 * a background script's run reaches its parent and its siblings this way.
 */
const reuseScope = Effect.fn('agent.reuseScope')(function* (call: RunToolCall) {
  const { session, runId } = call.run;
  const view = yield* session.view.read([]);
  const root =
    view.runs.get(runId)?.identity.kind === 'script'
      ? (view.runs.get(runId)?.parentId ?? runId)
      : runId;
  return [
    root,
    ...(view.runs.get(root)?.childIds ?? []).filter(
      (id) => view.runs.get(id)?.identity.kind === 'script',
    ),
  ];
});

/** What the calling run and every run under it have spent so far. */
const spentBy = (call: RunToolCall) =>
  Effect.map(
    call.run.session.view.read([]),
    ({ runs }) => runs.get(call.run.runId)?.treeUsage.cost ?? 0,
  );

/**
 * A completed call in the reuse scope whose key is `key`, or a rejection when
 * one of this same script holds it: two calls of one script that would
 * answer the same must say how they differ (`id`). Read from the runs'
 * `tool.result` rows; only an executed result carries a key.
 */
export const reusable = Effect.fn('agent.reusable')(function* (
  call: RunToolCall,
  script: ScriptScope,
  key: string,
) {
  const siblings = yield* script.shared(
    'agent:keys',
    Effect.sync(() => new Map<string, string>()),
  );
  const { callId } = call;
  const duplicate = errorResult(
    'Another agent call of this script has the same prompt, options and files. Give each a distinct `id` to run both.',
    { name: 'DuplicateCall' },
  );
  // Claimed before the read yields, so two calls at once cannot both pass.
  const claimed = siblings.get(key);
  if (claimed !== undefined && claimed !== callId) return duplicate;
  siblings.set(key, callId);
  const { log } = call.run.session;
  const rows = (yield* Effect.forEach(yield* reuseScope(call), (runId) =>
    log.rows(qualifyAggregateId('run', runId), ['tool.result']),
  )).flat();
  const found = rows.flatMap((row) =>
    row.type === 'tool.result' &&
    row.payload.result.status === 'executed' &&
    row.payload.result.reuseKey === key
      ? [{ ...row.payload, result: row.payload.result }]
      : [],
  );
  const mine = `${script.callId}/`;
  // A sibling a resume handed back from its row never ran here to claim.
  if (
    found.some(
      (row) =>
        row.responseId === call.responseId &&
        row.callId.startsWith(mine) &&
        row.callId !== callId,
    )
  )
    return duplicate;
  const origin = found.at(-1);
  if (origin === undefined) return null;
  const from = origin.result.reusedFrom ?? origin.callId;
  const { value } = origin.result;
  return {
    ...origin.result,
    output: `Reused the result of call ${from}: nothing ran again.\n\n${origin.result.output ?? ''}`,
    reusedFrom: from,
    // What this run has spent is read now, not where the result was made.
    ...(typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) && {
        value: { ...value, spent: yield* spentBy(call) },
      }),
  } satisfies ToolResult;
});
