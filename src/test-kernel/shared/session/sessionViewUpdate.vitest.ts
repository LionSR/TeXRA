// The session view's updater over a recorded fan-out session: a background
// script root, one child agent run with a grandchild of its own, a background
// process run. The scenario (`fanOutScenario.ts`) is the commit-ordered event
// log a publisher would replay; every assertion compares the view to what the
// shared projections it must reproduce say, so the two can never drift.

import { describe, expect, it } from 'vitest';

import { Result, Schema } from 'effect';

import { runHistoryRows, storedDraft } from '@agent/runtime/storedTurn';
import {
  qualifyAggregateId,
  emptyRunEndOutput,
  DISPLAY_EVENT_TYPES,
  listingTypeOf,
  RUN_PHASE,
  RunIdSchema,
  SessionEventSchema,
  type RunId,
} from '@shared/schemas';

import type { RunHistoryRow } from '@shared/session/historyTurns';
import { applyRunRows, type RunHistoryDraft } from '@shared/session/runState';
import { type SessionView, type RunView } from '@shared/session/sessionView';
import { makeSessionViewUpdater } from '@shared/session/sessionViewUpdate';
import {
  loadSurface,
  persistSurface,
  PersistedSurfaceSchema,
} from '@texra/shared/session/surface';
import { markShownRunSeen, unseenRuns } from '@texra/shared/session/unseenRuns';

import {
  CHILD,
  CHILD_IDENTITY,
  GRANDCHILD,
  Log,
  OWNER,
  PROCESS,
  ROOT,
  ROOT_IDENTITY,
  buildScenario,
  local,
  subscribe,
  tail,
  viewOf,
} from './fanOutScenario';

function runView(view: SessionView, id: RunId): RunView {
  const found = view.runs.get(id);
  if (!found) throw new Error(`run ${id} missing from the view`);
  return found;
}

const alive = local({ self: [OWNER] });
const nobody = local({ dead: [OWNER] });

/** A fresh updater of the fixture session. */
const paper = (cursor = 0, debug = false) =>
  makeSessionViewUpdater('paper', cursor, debug);

describe('session view update', () => {
  const scenario = buildScenario();

  it('keeps read conversations read across history replay and restart while detecting later activity', () => {
    const log = new Log();
    const start = log.emit(ROOT, 1000, {
      type: 'run.start',
      identity: ROOT_IDENTITY,
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    });
    const response = log.emit(ROOT, 2000, {
      type: 'response.finalized',
      text: 'Ready for review.',
    });
    const end = log.emit(ROOT, 3000, {
      type: 'run.end',
      outcome: 'completed',
      output: emptyRunEndOutput(),
    });
    const updater = paper();
    const listing = viewOf(
      [start, end].map((event) => ({
        _tag: 'event',
        read: 'listing',
        event,
      })),
      updater,
    );
    const history = viewOf([subscribe(ROOT), ...log.events.map(tail)], updater);
    const surface = loadSurface(
      'paper',
      Schema.decodeUnknownSync(PersistedSurfaceSchema)({ selected: ROOT }),
    );
    const read = markShownRunSeen(surface, history);
    const restarted = loadSurface('paper', persistSurface(read));
    expect(unseenRuns(restarted, listing)).toEqual(new Set());
    expect(runView(history, ROOT).lastTimestamp).toBe(end.at);

    // A partial replay must never move an existing read marker backwards.
    const partial = viewOf([tail(start), subscribe(ROOT), tail(response)]);
    expect(markShownRunSeen(restarted, partial)).toBe(restarted);
    const later = updater.apply(
      tail(
        log.emit(ROOT, 4000, {
          type: 'run.end',
          outcome: 'completed',
          output: emptyRunEndOutput(),
        }),
      ),
    );
    expect(unseenRuns(restarted, later)).toEqual(new Set([ROOT]));
    expect(unseenRuns(markShownRunSeen(restarted, later), later)).toEqual(
      new Set(),
    );
  });

  it('projects completed trace facts identically live and on replay without applying the listing as transcript', () => {
    const log = new Log();
    const start = log.emit(CHILD, 1000, {
      type: 'run.start',
      identity: CHILD_IDENTITY,
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    });
    const stage = log.emit(CHILD, 1010, {
      type: 'stage.start',
      id: 'round',
      label: 'Round 1',
      kind: 'session',
    });
    const opened = log.emit(CHILD, 1020, {
      type: 'stream.start',
      id: 'response',
      kind: 'modelResponse',
      stageId: 'round',
    });
    const completed = log.emit(CHILD, 1030, {
      type: 'stream.end',
      id: 'response',
      finalText: 'The integral is zero.',
      stageId: 'round',
    });
    const completedText = 'The integral vanishes.\n'.repeat(3000);
    const final = log.emit(CHILD, 1040, {
      type: 'response.finalized',
      text: completedText,
      stageId: 'round',
    });
    const ended = log.emit(CHILD, 1050, {
      type: 'stage.end',
      id: 'round',
      status: 'completed',
    });
    const notice = log.emit(CHILD, 1060, {
      type: 'log',
      level: 'info',
      message: 'Calculation complete.',
      stageId: 'round',
    });
    const debug = log.emit(CHILD, 1070, {
      type: 'log',
      level: 'debug',
      message: 'Captured debug detail.',
    });
    // A verbose view: transcript verbosity is the view's own flag, read from
    // its config authority at open — never a property of a row.
    const initial = () => {
      const updater = paper(0, true);
      viewOf([tail(start), subscribe(CHILD), alive], updater);
      return updater;
    };
    const live = viewOf(
      [
        tail(stage),
        tail(opened),
        {
          _tag: 'chunk',
          runId: CHILD,
          rowId: 'response',
          from: 0,
          to: 12,
          text: 'The integral',
        },
        ...[completed, final, ended, notice, debug].map(tail),
      ],
      initial(),
    );
    const replayed = initial();
    const listing = replayed.apply({
      _tag: 'event',
      read: 'listing',
      event: stage,
    });
    expect(runView(listing, CHILD).transcript.rows).toEqual([]);
    expect(listing.transcriptSeq.get(qualifyAggregateId('run', CHILD))).toBe(0);
    const replay = viewOf(
      log.events.map((event) => ({ _tag: 'event', read: 'aggregate', event })),
      replayed,
    );
    expect(runView(replay, CHILD).transcript).toEqual(
      runView(live, CHILD).transcript,
    );
    expect(runView(replay, CHILD).transcript.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: expect.objectContaining({ full: completedText }),
        }),
      ]),
    );
    const hidden = log.emit(CHILD, 1080, {
      type: 'log',
      level: 'debug',
      message: 'Hidden debug detail.',
    });
    // The same rows on a quiet view: the debug row is dropped, its cursor
    // still advances.
    const quietly = paper(0, false);
    viewOf([subscribe(CHILD), alive], quietly);
    const quiet = viewOf(
      log.events
        .filter((event) => event !== hidden)
        .map((event) => ({ _tag: 'event', read: 'aggregate', event })),
      quietly,
    );
    const filtered = quietly.apply(tail(hidden));
    expect(filtered.runs).toBe(quiet.runs);
    expect(filtered.transcriptSeq.get(qualifyAggregateId('run', CHILD))).toBe(
      hidden.seq,
    );
  });

  it('reads a pending approval as waiting only with a held owner', () => {
    const withOwner = viewOf([...scenario.pending, alive]);
    expect(runView(withOwner, CHILD).group).toBe('waiting');
    expect(runView(withOwner, CHILD).approval).toBe('own');
    expect(runView(withOwner, CHILD).readOnly).toBe(false);
    expect(runView(withOwner, ROOT).approval).toBe('descendant');
    expect(runView(withOwner, ROOT).group).toBe('running');
    // The path to the decision is forced open.
    expect(runView(withOwner, ROOT).forceExpanded).toBe(true);
    expect(withOwner.requests.map((r) => r.requestId)).toStrictEqual(['req-1']);

    // The same log with nobody holding the owner: every in-flight run is
    // interrupted, never waiting. The phase stays running and the request
    // stays listed, so a resume can re-ask, and the interrupted path is
    // forced open too.
    const interrupted = viewOf([...scenario.pending, nobody]);
    const child = runView(interrupted, CHILD);
    expect(child.group).toBe('interrupted');
    expect(child.approval).toBe('none');
    expect(child.status).toBe(RUN_PHASE.RUNNING);
    expect(child.readOnly).toBe(false);
    expect(runView(interrupted, ROOT).group).toBe('interrupted');
    expect(runView(interrupted, ROOT).forceExpanded).toBe(true);
    expect(interrupted.requests).toHaveLength(1);
    // A run with only its run.start (its process died before the first
    // activation) is non-terminal and ownerless: interrupted, and resumable.
    expect(runView(interrupted, PROCESS).status).toBe('ready');
    expect(runView(interrupted, PROCESS).group).toBe('interrupted');
    expect(runView(withOwner, PROCESS).group).toBe('recent');
    expect(interrupted.rollup).toStrictEqual({
      running: 0,
      waiting: 0,
      interrupted: 3,
    });

    // A current claim without a liveness verdict remains held as unprovable.
    const unknown = viewOf(scenario.pending);
    expect(runView(unknown, CHILD).group).toBe('waiting');
    expect(runView(unknown, CHILD).readOnly).toBe(true);
  });

  it("sums each run's tree total once, grandchildren included", () => {
    // Failure modes: a total that adds direct children only; a listing
    // total and its replayed turns counted twice up the tree; a run's own
    // `usage` absorbing its children's.
    const log = new Log();
    const startOf = (id: RunId, parent: RunId | null) =>
      log.emit(id, 4000, {
        type: 'run.start',
        identity: id === ROOT ? ROOT_IDENTITY : CHILD_IDENTITY,
        userFollowUpSupport: 'unsupported',
        parent: parent === null ? null : log.parent(parent),
        provenance: null,
      });
    const starts = [
      startOf(ROOT, null),
      startOf(CHILD, ROOT),
      startOf(GRANDCHILD, CHILD),
    ];
    const turn = (id: RunId, cost: number) =>
      log.emit(id, 4010, {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 1, cost },
      });
    const turns = [turn(ROOT, 0.25), turn(CHILD, 0.5), turn(GRANDCHILD, 1)];
    const view = viewOf(
      [...starts, ...turns].map((event) => ({
        _tag: 'event' as const,
        read: 'aggregate' as const,
        event,
      })),
    );
    expect(runView(view, ROOT).usage.cost).toBe(0.25);
    expect(runView(view, ROOT).treeUsage).toMatchObject({
      cost: 1.75,
      inputTokens: 30,
    });
    expect(runView(view, CHILD).treeUsage.cost).toBe(1.5);
    expect(runView(view, GRANDCHILD).treeUsage.cost).toBe(1);

    // A cold listing of the grandchild's total, then its replayed turn:
    // the root's total still counts that turn once.
    const listed = viewOf([
      ...starts.map((event) => ({
        _tag: 'event' as const,
        read: 'listing' as const,
        event,
      })),
      { _tag: 'event', read: 'listing', event: turns[2]! },
      { _tag: 'event', read: 'aggregate', event: turns[2]! },
    ]);
    expect(runView(listed, ROOT).treeUsage.cost).toBe(1);
  });

  it('re-roots the children of a removed run, keeps the removal final, and closes the listing at the marker', () => {
    const removed = scenario.log.emit(ROOT, 3000, {
      type: 'run.removed',
      runIds: [],
    });
    const updater = paper();
    viewOf(scenario.events, updater);
    const view = viewOf([tail(removed)], updater);
    expect(view.runs.has(ROOT)).toBe(false);
    expect(view.policy.has(ROOT)).toBe(false);
    expect(view.transcriptSeq.has(qualifyAggregateId('run', ROOT))).toBe(false);
    expect(view.order).toStrictEqual([PROCESS, CHILD]);
    expect(runView(view, CHILD).parentId).toBeNull();
    expect(runView(view, CHILD).ancestors).toStrictEqual([]);
    expect(runView(view, GRANDCHILD).ancestors).toStrictEqual([
      { id: CHILD, label: runView(view, CHILD).label },
    ]);

    // A read replaying the run.start beneath the removal does not recreate
    // the run: the lifecycle pair shares one latest entry.
    const rootStart = scenario.log.events.find(
      (e) =>
        e.aggregateId === qualifyAggregateId('run', ROOT) &&
        e.type === 'run.start',
    )!;
    const replayed = updater.apply({
      _tag: 'event',
      read: 'aggregate',
      event: rootStart,
    });
    expect(replayed.runs.has(ROOT)).toBe(false);

    // At the replay marker, a run no listing row named is gone with
    // everything a removal clears.
    const processStart = scenario.log.events.find(
      (e) =>
        e.aggregateId === qualifyAggregateId('run', PROCESS) &&
        e.type === 'run.start',
    )!;
    const pruning = paper();
    viewOf(scenario.pending, pruning);
    const pruned = viewOf(
      [
        { _tag: 'event', read: 'listing', event: processStart },
        {
          _tag: 'replay.complete',
          existence: {
            checkedAggregateIds: [processStart.aggregateId],
            claims: [{ aggregateId: processStart.aggregateId, ownerId: OWNER }],
          },
        },
      ],
      pruning,
    );
    expect([...pruned.runs.keys()]).toStrictEqual([PROCESS]);
    expect(pruned.order).toStrictEqual([PROCESS]);
    expect(pruned.requests).toStrictEqual([]);
    expect(pruned.policy.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The run-state fold: the sibling of `fold` that produces what the loop
// continues from. Rows are built through `SessionEventSchema`, the boundary
// that runs in production; nothing here reaches an arm schema directly.
// ---------------------------------------------------------------------------

const RUN_HISTORY_RUN = Schema.decodeUnknownSync(RunIdSchema)('ab12cd');
const RUN_HISTORY_AGGREGATE = qualifyAggregateId('run', RUN_HISTORY_RUN);
const ORIGIN = {
  protocol: 'openai-responses',
  requestedModel: 'gpt-test',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'openai',
  },
  codecVersion: 1,
} as const;
const INVOCATION = {
  invocationId: '0f1e2d3c-4b5a-4a9b-8c7d-6e5f4a3b2c1d',
  attempt: 1,
} as const;
const RESPONSE_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const USER = (text: string) => ({
  role: 'user',
  content: [{ kind: 'text', text }],
});
const TURN = {
  kind: 'http',
  providerResponseId: 'resp-1',
  requestedOrigin: ORIGIN,
  returnedModel: null,
  modelFingerprint: null,
  content: [
    { kind: 'message', content: [{ kind: 'text', text: 'running ls' }] },
    {
      kind: 'local-call',
      providerCallId: 'call-a',
      name: 'bash',
      argumentsText: '{"command":"ls"}',
    },
    {
      kind: 'local-call',
      providerCallId: 'call-b',
      name: 'bash',
      argumentsText: '{"command":"ls"}',
    },
  ],
  finishReason: 'tool-calls',
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedInputTokens: 4,
    reasoningTokens: null,
  },
};
const CALLS = [
  {
    callId: 'call-a',
    toolName: 'bash',
    lane: 'barrier',
    replay: 'unsafe',
    duplicateOf: null,
    logId: 'card-0',
  },
  {
    callId: 'call-b',
    toolName: 'bash',
    lane: 'barrier',
    replay: 'unsafe',
    duplicateOf: 'call-a',
    logId: 'card-1',
  },
];
/** What the writer stamps beside `calls`: the runtime's priced usage. */
const TURN_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cost: 0.25,
  responseTimeMs: 1200,
  provider: 'openai-responses',
  cachedInputTokens: 4,
  cacheMissInputTokens: 6,
};
/** Where the loop stands: its first position opens the run. */
const position = (at: string, turn: number) => ({
  type: 'run.position',
  payload: { family: 'toolUse', at, turn },
});

/** The row a call's body starts with. */
const intent = (callId: string, attempt = 1) => ({
  type: 'tool.intent',
  payload: {
    origin: { kind: 'response', responseId: RESPONSE_ID },
    callId,
    attempt,
  },
});
const message = (payload: Record<string, unknown>) => ({
  type: 'model.message',
  payload,
});
const settlement = (
  callId: string,
  overrides: Record<string, unknown> = {},
) => ({
  type: 'tool.result',
  payload: {
    responseId: RESPONSE_ID,
    callId,
    attempt: 1,
    disposition: 'executed',
    duplicateOf: null,
    result: { status: 'executed', output: 'ok' },
    attachments: [],
    ...overrides,
  },
});
const TOOL_GROUP = {
  role: 'tool',
  results: [
    {
      callOrdinal: 0,
      status: 'success',
      content: [{ kind: 'text', text: 'ok' }],
    },
    {
      callOrdinal: 1,
      status: 'success',
      content: [{ kind: 'text', text: 'ok' }],
    },
  ],
};

/** One committed row, stored and read back through the production boundary. */
const runHistoryRow = (
  commit: number,
  draft: Record<string, unknown>,
): RunHistoryRow =>
  Result.getOrThrow(
    runHistoryRows([
      Schema.decodeUnknownSync(SessionEventSchema)({
        ...storedDraft({
          aggregateId: RUN_HISTORY_AGGREGATE,
          ...draft,
        } as unknown as RunHistoryDraft),
        seq: commit,
        commit,
        origin: null,
        at: 0,
      }),
    ]),
  )[0]!;

/** The same boundary, asked whether it accepts the draft at all. */
const rowAccepted = (draft: Record<string, unknown>): boolean =>
  Result.isSuccess(
    Schema.decodeUnknownResult(SessionEventSchema)({
      aggregateId: RUN_HISTORY_AGGREGATE,
      ...draft,
      seq: 1,
      commit: 1,
      origin: null,
      at: 0,
    }),
  );

/** The whole life of one tool-use turn, commit by commit. */
const TURN_ROWS: readonly RunHistoryRow[] = [
  message({
    kind: 'append',
    messages: [USER('list the files')],
    sourceResponse: null,
  }),
  position('turn.ready', 0),
  message({
    kind: 'attempt',
    request: '0'.repeat(64),
    invocation: INVOCATION,
    origin: ORIGIN,
    purpose: 'turn',
  }),
  message({
    kind: 'identified',
    invocation: INVOCATION,
    providerResponseId: 'resp-1',
  }),
  message({
    kind: 'response',
    responseId: RESPONSE_ID,
    invocation: INVOCATION,
    turn: TURN,
    calls: CALLS,
    usage: TURN_USAGE,
  }),
  intent('call-a'),
  settlement('call-a'),
  settlement('call-b', { disposition: 'duplicate', duplicateOf: 'call-a' }),
  message({
    kind: 'append',
    messages: [TOOL_GROUP],
    sourceResponse: RESPONSE_ID,
  }),
  position('results.ready', 1),
  {
    type: 'run.position',
    payload: { family: 'toolUse', at: 'turn.end', turn: 1 },
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
      'after the body started, before its result: outcome unknown, never fabricated',
      () => {
        const state = stateOf(through(6));
        expect(state?.pendingResponse?.records['call-a']?.status).toEqual({
          kind: 'started',
          attempt: 1,
        });
        expect(state?.pendingResponse?.records['call-b']?.status).toEqual({
          kind: 'issued',
        });
      },
    ],
    [
      'after a paid response, before the turn-end snapshot: process, never re-invoke',
      () => {
        const state = stateOf(through(5));
        expect(state?.invocation).toBeNull();
        expect(state?.pendingResponse?.responseId).toBe(RESPONSE_ID);
        expect(state?.phase).toBe('model.submitted');
        expect(state?.messages).toHaveLength(1);
      },
    ],
    [
      'a provider call id of __proto__: an own entry, never a prototype setter',
      () => {
        const state = stateOf(
          through(
            3,
            message({
              kind: 'response',
              responseId: RESPONSE_ID,
              invocation: INVOCATION,
              turn: {
                ...TURN,
                content: [
                  {
                    kind: 'local-call',
                    providerCallId: '__proto__',
                    name: 'bash',
                    argumentsText: '{"command":"ls"}',
                  },
                ],
              },
              calls: [{ ...CALLS[0], callId: '__proto__' }],
              usage: null,
            }),
            {
              type: 'tool.intent',
              payload: {
                origin: { kind: 'response', responseId: RESPONSE_ID },
                callId: '__proto__',
                attempt: 1,
              },
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
    const state = stateOf(through(11));
    expect(state?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(state?.pendingResponse).toBeNull();
    expect(state?.usage.totalInputTokens).toBe(10);
    expect(state?.usage.totalCacheReadInputTokens).toBe(4);
    // The turn's stamped price: a settlement adds nothing to it.
    expect(state?.usage.totalCost).toBe(0.25);
    // Incremental and cold folds are the same computation.
    const half = stateOf(applyRunRows(null, TURN_ROWS.slice(0, 6)));
    expect(stateOf(applyRunRows(half, TURN_ROWS.slice(6)))).toEqual(state);
  });

  it.each([
    [
      // A call's attempt never goes back: attempt 2's body started, so
      // attempt 1 settling now would retire attempt 2's uncertainty silently.
      'out-of-order',
      () => through(6, intent('call-a', 2), settlement('call-a')),
    ],
    [
      // A call settles once.
      'orphan-settlement',
      () => through(7, settlement('call-a', { attempt: 2 })),
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
            phase: null,
          },
        },
        settlement('call-a/0', {
          result: { status: 'executed', output: 'ok', value: { a: 1 } },
        }),
      ),
    );
    expect(state?.structured).toEqual({ value: { a: 1 } });
  });

  it('keeps the private run history types out of the listing and off the transport, and lists run.position', () => {
    const runHistoryTypes = [
      'model.message',
      'context.edit',
      'tool.intent',
      'tool.result',
    ] as const;
    for (const type of runHistoryTypes)
      expect(listingTypeOf({ type })).toBeNull();
    // The one run history row the listing keys: a cold hydrate that dropped it
    // would paint every parked run as ready (ruling A9-5).
    expect(listingTypeOf({ type: 'run.position' })).toBe('run.position');
    for (const row of TURN_ROWS) {
      expect(DISPLAY_EVENT_TYPES.includes(row.type)).toBe(
        row.type === 'run.position',
      );
    }
  });

  it('binds every row to the turn it describes', () => {
    const response = (calls: unknown) =>
      message({
        kind: 'response',
        responseId: RESPONSE_ID,
        invocation: INVOCATION,
        turn: TURN,
        calls,
        usage: null,
      });
    // A dispatch fact stands for one local call: its order, its id, and the
    // tool the provider asked for. Recovery dispatches what the fact names.
    expect(rowAccepted(response(CALLS))).toBe(true);
    expect(
      rowAccepted(response([{ ...CALLS[0], toolName: 'rm' }, CALLS[1]])),
    ).toBe(false);
    // The delivered tool group takes its provider-facing status from the
    // result, so a call the run recorded as failed carries an error result.
    expect(rowAccepted(settlement('call-a', { disposition: 'failed' }))).toBe(
      false,
    );
    expect(
      rowAccepted(
        settlement('call-a', {
          disposition: 'failed',
          result: { status: 'error', error: 'exit 1' },
        }),
      ),
    ).toBe(true);
    // Attachment metadata is JSON. The two binary fields are dropped; a third
    // one under a loose key would be a `JSON.stringify` throw on a live run.
    const attachment = (extra: Record<string, unknown>) =>
      settlement('call-a', {
        result: {
          status: 'executed',
          output: 'ok',
          files: [
            {
              path: 'out/plot.png',
              mimeType: 'image/png',
              bytes: new Uint8Array([1, 2]),
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
