// The session view's updater over a recorded fan-out session: a background
// script root, one child agent run with a grandchild of its own, a background
// process run. The scenario (`fanOutScenario.ts`) is the commit-ordered event
// log a publisher would replay; every assertion compares the view to what the
// shared projections it must reproduce say, so the two can never drift.

import { describe, expect, it } from 'vitest';

import { Result, Schema } from 'effect';

import {
  isInterrupted,
  MESSAGE_TYPES,
  needsUser,
  qualifyAggregateId,
  type RunId,
  RunIdSchema,
  type RunView,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { runHistoryRows, storedDraft } from '@agent/runtime/providerMessages';
import { SessionRowSchema } from '@shared/schemas';
import { makeSessionViewUpdater } from '@shared/session/sessionViewUpdate';

import type { RunHistoryRow } from '@shared/session/historyTurns';
import { applyRunRows, type RunHistoryDraft } from '@shared/session/runState';
import { nextAttempt, type Invocation } from '@shared/session/inFlight';
import type { RunRowState } from '@shared/session/runRowsShape';

import { toolUseTurn } from '@test/support/sessionRows';
import {
  CHILD,
  Log,
  ALL_RUNS,
  PROCESS,
  ROOT,
  T,
  buildScenario,
  local,
  subscribe,
  tail,
  viewOf,
} from '@test/shared/session/fanOutScenario';

function runView(view: SessionView, id: RunId): RunView {
  const found = view.runs.get(id);
  if (!found) throw new Error(`run ${id} missing from the view`);
  return found;
}

const alive = local({ runsHere: ALL_RUNS });
const nobody = local({ runsHere: [] });

describe('session view update', () => {
  const scenario = buildScenario();

  it('reads a pending approval as waiting only with a held owner', () => {
    const withOwner = viewOf([...scenario.pending, alive]);
    expect(runView(withOwner, CHILD).holder).toBe('here');
    expect(runView(withOwner, CHILD).approval).toBe('own');
    expect(runView(withOwner, ROOT).approval).toBe('descendant');
    expect(runView(withOwner, ROOT).holder).toBe('here');
    // The path to the decision is forced open.
    expect(needsUser(runView(withOwner, ROOT), withOwner.runs)).toBe(true);
    expect(withOwner.requests.map((r) => r.requestId)).toStrictEqual(['req-1']);

    // The same log with nobody holding the owner: every in-flight run is
    // interrupted, never waiting. The phase stays running and the request
    // stays listed, so a resume can re-ask, and the interrupted path is
    // forced open too.
    const interrupted = viewOf([...scenario.pending, nobody]);
    const child = runView(interrupted, CHILD);
    expect(isInterrupted(child)).toBe(true);
    expect(child.approval).toBe('none');
    expect(child.position).toBe('running');
    expect(isInterrupted(runView(interrupted, ROOT))).toBe(true);
    expect(needsUser(runView(interrupted, ROOT), interrupted.runs)).toBe(true);
    expect(interrupted.requests).toHaveLength(1);
    // A run with only its run.start (its process died before the first
    // activation) is non-terminal and ownerless: interrupted, and resumable.
    expect(runView(interrupted, PROCESS).position).toBe('ready');
    expect(isInterrupted(runView(interrupted, PROCESS))).toBe(true);
    expect(runView(withOwner, PROCESS).holder).toBe('here');
    expect(interrupted.rollup).toStrictEqual({
      running: 0,
      waiting: 0,
      interrupted: 3,
    });
  });

  it('ends the turn of a run whose owner died mid-compaction', () => {
    const log = new Log();
    log.emit(ROOT, T.root, {
      type: 'run.start',
      identity: { kind: 'agent', agent: 'custom:search' },
      parent: null,
      provenance: null,
      takesFollowUps: true,
    });
    log.emit(ROOT, T.root, { type: 'run.activate' });
    log.emit(ROOT, T.root + 1, {
      type: 'log',
      level: 'info',
      message: '',
      messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
      data: {
        activity: 'context_compaction',
        operationId: 'op-1',
        state: 'started',
      },
    });
    const updater = makeSessionViewUpdater('paper');
    const inputs = [subscribe(ROOT), ...log.events.map(tail), log.drained()];
    const held = runView(viewOf([...inputs, alive], updater), ROOT);
    expect(held.compactingActive).toBe(true);
    expect(held.transcript.settledRows).toBe(0);

    // No row says the turn ended; the owner's death alone ends it, so the
    // open compaction finishes and the scrollback may print every row.
    const lost = runView(viewOf([nobody], updater), ROOT);
    expect(isInterrupted(lost)).toBe(true);
    expect(lost.compactingActive).toBe(false);
    expect(lost.transcript.rows).toHaveLength(1);
    expect(lost.transcript.settledRows).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The run-state fold: the sibling of `fold` that produces what the loop
// continues from. Rows are built through `SessionRowSchema`, the boundary
// that runs in production; nothing here reaches an arm schema directly.
// ---------------------------------------------------------------------------

const RUN_HISTORY_RUN = Schema.decodeUnknownSync(RunIdSchema)('ab12cd');
const RUN_HISTORY_AGGREGATE = qualifyAggregateId('run', RUN_HISTORY_RUN);
const toolTurn = toolUseTurn(RUN_HISTORY_RUN);
/** Where the loop stands: its first position opens the run. */
const position = (at: string, turn: number) => ({
  type: 'run.position',
  payload: { at, turn },
});
const message = (payload: Record<string, unknown>) => ({
  type: 'model.message',
  payload,
});

/** One committed row, stored and read back through the production boundary. */
const runHistoryRow = (
  commit: number,
  draft: Record<string, unknown>,
): RunHistoryRow =>
  Result.getOrThrow(
    runHistoryRows([
      Schema.decodeUnknownSync(SessionRowSchema)({
        // cast: each case writes a run-history draft; the decode around it checks it.
        ...Result.getOrThrow(
          storedDraft({
            aggregateId: RUN_HISTORY_AGGREGATE,
            ...draft,
          } as unknown as RunHistoryDraft),
        ),
        seq: commit,
        commit,
        at: 0,
      }),
    ]),
  )[0];

/** The same boundary, asked whether it accepts the draft at all. */
const rowAccepted = (draft: Record<string, unknown>): boolean =>
  Result.isSuccess(
    Schema.decodeUnknownResult(SessionRowSchema)({
      aggregateId: RUN_HISTORY_AGGREGATE,
      ...draft,
      seq: 1,
      commit: 1,
      at: 0,
    }),
  );

/** The whole life of one tool-use turn, commit by commit. */
const TURN_ROWS: readonly RunHistoryRow[] = [
  toolTurn.append,
  position('turn.ready', 0),
  toolTurn.attempt,
  toolTurn.identified,
  toolTurn.response,
  toolTurn.intent,
  toolTurn.result('call-a'),
  toolTurn.result('call-b', {
    disposition: 'duplicate',
    duplicateOf: 'call-a',
  }),
  toolTurn.delivery,
  {
    type: 'run.position',
    payload: {
      at: 'turn.end',
      turn: 1,
      outcome: 'completed',
    },
  },
].map((draft, index) => runHistoryRow(index + 1, draft));

const through = (count: number, ...extra: Record<string, unknown>[]) =>
  applyRunRows(null, [
    ...TURN_ROWS.slice(0, count),
    ...extra.map((draft, index) => runHistoryRow(count + index + 1, draft)),
  ]);

const stateOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};
const reasonOf = <A>(result: Result.Result<A, { reason: string }>): string =>
  Result.isFailure(result) ? result.failure.reason : 'success';

describe('applyRunRows', () => {
  it.each([
    [
      'a provider call id of __proto__: an own entry, never a prototype setter',
      () => {
        const state = stateOf(
          through(
            3,
            message({
              kind: 'response',
              responseId: toolTurn.responseId,
              invocation: toolTurn.invocation,
              turn: {
                ...toolTurn.providerTurn,
                content: [
                  {
                    kind: 'local-call',
                    providerCallId: '__proto__',
                    name: 'bash',
                    argumentsText: '{"command":"ls"}',
                  },
                ],
              },
              calls: [{ ...toolTurn.calls[0], callId: '__proto__' }],
              usage: null,
            }),
            {
              type: 'tool.intent',
              payload: { ...toolTurn.intent.payload, callId: '__proto__' },
            },
          ),
        );
        // On a plain object the assignment would call the inherited setter and
        // the barrier would vanish from the state the resume rule reads.
        expect(Object.keys(state?.pendingResponse?.records ?? {})).toEqual([
          '__proto__',
        ]);
        expect(state?.pendingResponse?.records['__proto__']?.status).toEqual({
          kind: 'started',
          attempt: 1,
        });
      },
    ],
  ])('%s', (_name, check) => check());

  it('delivers the paid assistant turn once and derives usage from the rows', () => {
    const state = stateOf(through(10));
    expect(state?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(state?.pendingResponse).toBeNull();
    expect(state?.usage.inputTokens).toBe(10);
    expect(state?.usage.cachedInputTokens).toBe(4);
    // The turn's stamped price: a settlement adds nothing to it.
    expect(state?.usage.cost).toBe(0.25);
    // Incremental and cold folds are the same computation.
    const half = stateOf(applyRunRows(null, TURN_ROWS.slice(0, 6)));
    expect(stateOf(applyRunRows(half, TURN_ROWS.slice(6)))).toEqual(state);
  });

  it.each([
    [
      // A call's attempt never goes back: attempt 2's body started, so
      // attempt 1 settling now would retire attempt 2's uncertainty silently.
      'out-of-order',
      () =>
        through(
          6,
          {
            ...toolTurn.intent,
            payload: { ...toolTurn.intent.payload, attempt: 2 },
          },
          toolTurn.result('call-a'),
        ),
    ],
    [
      // A call settles once.
      'orphan-settlement',
      () => through(7, toolTurn.result('call-a', { attempt: 2 })),
    ],
  ])('refuses loudly: %s', (reason, run) => {
    expect(reasonOf(run())).toBe(reason);
  });

  // A `submit_output` a script issued is the run's structured output, read
  // off the same settlement as a direct call's: under codemode the model
  // submits from inside its script, and losing it would leave the run with
  // no output and a latch that refuses a second submission.
  it('folds a structured output a script submitted', () => {
    const state = stateOf(
      through(
        5,
        {
          type: 'script.call',
          payload: {
            scriptCallId: 'call-a',
            seq: 0,
            callId: 'call-a/0',
            toolName: 'submit_output',
            input: {},
            replay: 'unsafe',
            logId: 'log-s0',
            stageId: 'stage-s',
            section: null,
          },
        },
        toolTurn.result('call-a/0', {
          result: { status: 'executed', output: 'ok', value: { a: 1 } },
        }),
      ),
    );
    expect(state?.structured).toEqual({ value: { a: 1 } });
  });

  // A forced request that fails or is stopped leaves its nudge owed. The
  // loop forces only for a nudge of the turn it stands in, so the nudge must
  // keep the turn it was appended in once the next turn begins.
  it('keeps a final-tool nudge on the turn it was appended in', () => {
    const state = stateOf(
      through(
        9,
        message({
          kind: 'append',
          sourceResponse: null,
          messages: [
            { role: 'user', content: [{ kind: 'text', text: 'submit' }] },
          ],
          reason: 'final-tool',
        }),
        position('turn.begin', 1),
      ),
    );
    expect(state?.finalTool).toEqual({ turn: 0, owed: true });
    expect(state?.turn).toBe(1);
  });

  it('binds every row to the turn it describes', () => {
    const response = (calls: unknown) =>
      message({
        kind: 'response',
        responseId: toolTurn.responseId,
        invocation: toolTurn.invocation,
        turn: toolTurn.providerTurn,
        calls,
        usage: null,
      });
    // A dispatch fact stands for one local call: its order, its id, and the
    // tool the provider asked for. Recovery dispatches what the fact names.
    expect(rowAccepted(response(toolTurn.calls))).toBe(true);
    expect(
      rowAccepted(
        response([{ ...toolTurn.calls[0], toolName: 'rm' }, toolTurn.calls[1]]),
      ),
    ).toBe(false);
    // The delivered tool group takes its provider-facing status from the
    // result, so a call the run recorded as failed carries an error result.
    expect(
      rowAccepted(toolTurn.result('call-a', { disposition: 'failed' })),
    ).toBe(false);
    expect(
      rowAccepted(
        toolTurn.result('call-a', {
          disposition: 'failed',
          result: { status: 'error', error: 'exit 1' },
        }),
      ),
    ).toBe(true);
    // Attachment metadata is JSON. The two binary fields are dropped; a third
    // one under a loose key would be a `JSON.stringify` throw on a live run.
    const attachment = (extra: Record<string, unknown>) =>
      toolTurn.result('call-a', {
        result: {
          status: 'executed',
          output: 'ok',
          files: [
            {
              path: 'out/plot.png',
              mimeType: 'image/png',
              // cast: binary fields are not part of the row shape; the decode
              // must drop these two and refuse any other.
              bytes: new Uint8Array([1, 2]) as never,
              ...extra,
            },
          ],
        },
      });
    expect(rowAccepted(attachment({ sourceTool: 'bash' }))).toBe(true);
    expect(rowAccepted(attachment({ thumbnail: new Uint8Array([3]) }))).toBe(
      false,
    );
  });
});

describe('nextAttempt', () => {
  // A run stopped at its retry prompt ends with the prompt cancelled, as its
  // end cancels every open request. That cancel is no answer: read as one,
  // every resume would end the run cancelled again before taking any input.
  it('asks again about a retry prompt an earlier lifecycle cancelled', () => {
    const asked: Invocation = {
      current: {
        ref: { invocationId: '0'.repeat(8), attempt: 1 },
        sent: null,
        providerResponseId: null,
        accepted: null,
        failed: {
          error: { source: 'interrupted' },
          next: { kind: 'ask', requestId: 'retry-1' },
        },
        closed: false,
      },
      earlier: [],
    };
    const cancelledAt = (decidedAt: number) =>
      ({
        'retry-1': {
          decision: { action: 'cancel', cause: 'The run ended.' },
          decidedAt,
        },
        // cast: the rule reads a request's decision and when it was made.
      }) as unknown as RunRowState['requests'];
    // Cancelled at seq 5; the run was activated again at seq 9.
    expect(nextAttempt(asked, cancelledAt(5), 0, 9).kind).toBe('reask');
    // Cancelled by the person while this activation (seq 9) held the run.
    expect(nextAttempt(asked, cancelledAt(12), 0, 9).kind).toBe('cancel');
  });
});
