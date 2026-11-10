/**
 * Fork: a new root run whose history is another run's model view at a
 * settled position. The new run's `run.start` names where its history came
 * from (`provenance: { kind: 'fork', from, at }`), and its first run history
 * row is the `context.edit` that seeds that view, followed by the loop state
 * a resume restores and a `waiting` position: the fork is a conversation
 * waiting for its user's next message, which any host's Resume or follow-up
 * continues. The source's offered system text and tools are not copied: a
 * run's offered set is
 * recorded only where a step opens, so the fork's first step records its
 * own. Nothing pending is copied (no follow-up, request or retry permit),
 * its usage starts at zero, and of the source's own plugin facts it starts
 * with each kind's row at the cut that its policy copies (`FactKind.fork`).
 * `forkSeed` is the same cut as a child its caller launches at once: a
 * script's `self()`.
 */
import { Effect } from 'effect';

import { getRunRecords } from '@agent/storage/runOwnership';
import { registrationRows } from '@agent/storage/runLifecycle';
import type { SessionRoots } from '@platform/rootedFs';
import {
  qualifyAggregateId,
  blocksCaller,
  type RunId,
  generateRunId,
  factName,
  type AgentConfig,
} from '@shared/schemas';
import type { RegisterRunOptions } from '@shared/session/runFacts';
import { Rejected } from '@shared/session/runtimeRequest';
import {
  type Approvals,
  RunHistory,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import type { SessionViewAccessShape } from '@shared/session/sessionViewAccess';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import { descriptionRow } from '@shared/session/runFacts';
import { factRow } from '@tools/plugins';
import { ToolRegistry } from '@tools/toolTable';

import { configRow, positionRow } from './loop/rows';
import { addressedMessages } from './providerMessages';

/** Whether nothing is in flight: no invocation, response or undecided
 *  request its caller waits on (one it does not wait on stands across
 *  turns). A turn's beginning is quiet (its input is in,
 *  nothing answered it yet), so a child can be forked there. */
const isQuiet = (state: RunState): boolean =>
  state.invocation === null &&
  state.pendingResponse === null &&
  Object.values(state.requests).every(
    (request) => request.decision !== null || !blocksCaller(request.payload),
  );

/**
 * Whether the run stands at a settled position: at a turn boundary,
 * with no invocation (nor its retry), response (nor its calls) or undecided
 * request. A cut anywhere else would carry a result nobody produced.
 */
const isSettled = (state: RunState): boolean =>
  // Input taken for a turn that has not run (`turn.ready`) is inside it.
  (state.at === 'waiting' || state.at === 'turn.end') && isQuiet(state);

const refused = (reason: string) => new Rejected({ reason });

/** A run's noun in a refusal, one of the two the product uses: an agent is a
 *  run another run started, any other run is a task. */
export const runNoun = (
  view: Pick<SessionViewAccessShape, 'run'>,
  runId: RunId,
): 'task' | 'agent' => (view.run(runId)?.parentId == null ? 'task' : 'agent');

/** What a fork reads and writes of its session. */
type ForkServices =
  | ToolRegistry
  | SessionLog
  | SessionViewAccess
  | RunHistory
  | SessionRoots
  | Approvals;

/** Where a fork of `from` starts: a position of it with nothing in flight, `at` or (null)
 *  the latest, its state there, and its launch facts. */
const cutOf = Effect.fn('forkRun.cut')(function* (
  from: RunId,
  at: number | null,
  /** A child's fork: the latest such point committed before this
   *  commit, a turn's beginning included. */
  before?: number,
) {
  const log = yield* SessionLog;
  const runHistory = yield* RunHistory;
  const records = getRunRecords(from);
  const config = yield* records.readConfig();
  if (config === null || config.script != null) {
    return yield* refused('Only a conversation can be forked.');
  }
  const aggregate = qualifyAggregateId('run', from);
  const facts = yield* log.facts(from);
  const start = facts?.start;
  if (start == null) {
    const noun = runNoun(yield* SessionViewAccess, from);
    return yield* refused(`The ${noun} ${from} has no recorded start.`);
  }
  // The cut is a position row: a turn boundary of the source, not any seq.
  const parks = (yield* log.runRows(aggregate, 'positions')).positions.filter(
    (row) =>
      before === undefined
        ? row.payload.at === 'waiting'
        : row.commit < before &&
          ['waiting', 'turn.begin'].includes(row.payload.at),
  );
  const settledAt = (seq: number) =>
    Effect.map(runHistory.load(from, seq), (state) =>
      state !== null &&
      state.at !== null &&
      (before === undefined ? isSettled(state) : isQuiet(state))
        ? { seq, state }
        : null,
    );
  let found: Effect.Success<ReturnType<typeof settledAt>> = null;
  if (at !== null) {
    if (parks.some((park) => park.seq === at)) found = yield* settledAt(at);
  } else {
    // The latest turn boundary whose state is settled: the last park of a
    // conversation, or the one before the turn it is in now.
    for (const park of parks.toReversed()) {
      found = yield* settledAt(park.seq);
      if (found !== null) break;
    }
  }
  if (found === null) {
    return yield* refused(
      'A fork starts at a settled point of a conversation: the end of one of its turns.',
    );
  }
  // A child's fork is a root: the task its ancestors were given, and the
  // structured result its parent's call asked for, are not its. It runs on
  // the model its source was on at the cut, bound as it was.
  const {
    rootUserInstruction: _root,
    outputSchema: _schema,
    ...launched
  } = config;
  const record = { ...launched, model: found.state.modelId ?? launched.model };
  return { ...found, start, title: facts?.title ?? null, record };
});

/**
 * The rows that seed `runId` with `state`'s view and `messages`: the input
 * it answers with the content it names (its base system text and
 * instruction). The structured result of a turn the fork never ran stays
 * the source's. The offered tools and the system text a step adds are the
 * fork's first step's to record, as for any run.
 */
const viewRows = (
  runId: RunId,
  state: RunState,
  messages: RunState['messages'],
): RunHistoryDraft[] => {
  const { input } = state;
  const named = [input.system, input.instruction].filter(
    (digest) => digest !== undefined,
  );
  // The copied messages name their media by address: the fork's row links
  // the blobs, so deleting the source keeps them.
  const copied = addressedMessages(messages);
  return [
    {
      type: 'context.edit',
      aggregateId: qualifyAggregateId('run', runId),
      payload: {
        cause: 'fork',
        trigger: null,
        base: null,
        range: { from: 0, to: 0 },
        messages: copied.messages,
        usage: null,
        input,
      },
      ...(copied.blobs.length > 0 && { blobs: copied.blobs }),
    },
    ...named.map((digest): RunHistoryDraft => ({
      type: 'context.blob',
      aggregateId: qualifyAggregateId('run', runId),
      payload: { digest, value: state.contents[digest] },
    })),
  ];
};

/**
 * The source's own plugin facts the fork `runId` starts with: of each kind
 * whose policy copies it (`FactKind.fork`), the row `from` held at seq `cut`,
 * restated on the fork's history.
 */
const forkedFacts = Effect.fn('forkRun.facts')(function* (
  from: RunId,
  cut: number,
  runId: RunId,
) {
  const copied = new Set(
    [...(yield* ToolRegistry).entries.values()].flatMap(({ factKinds = [] }) =>
      factKinds.filter(({ fork }) => fork === 'copy').map(factName),
    ),
  );
  const aggregate = qualifyAggregateId('run', from);
  const log = yield* SessionLog;
  const { facts } = yield* log.runRows(aggregate, 'facts', cut);
  const kept = Object.values(facts).flatMap(
    ({ plugin, kind, version, value }) =>
      copied.has(factName({ plugin, kind }))
        ? [{ plugin, kind, version, value }]
        : [],
  );
  // Copied onto the fork as the rows the run held at the cut: no plugin's
  // own aggregate among them, and no rule to apply to a copy.
  return kept.map((fact) => factRow(fact, runId));
});

/**
 * Fork run `from` at `at`, the `seq` of a position in its run
 * history, or at the end of its last completed turn when `at` is null (a
 * run in a turn now is forked from before it). Returns the new run's id;
 * the run is written whole and left for its host to resume.
 */
export const forkRun = Effect.fn('forkRun')(function* (
  from: { readonly id: RunId; readonly uid: string },
  at: number | null,
): Effect.fn.Return<RunId, Rejected | Error, ForkServices> {
  const cutAt = yield* cutOf(from.id, at);
  const { seq: cut, state, start, title, record } = cutAt;
  const runId = generateRunId();
  const { rows } = yield* registrationRows(runId, record, {
    identity: start.identity,
    takesFollowUps: true,
    provenance: { kind: 'fork', from, at: cut },
  });
  // Registration, the source's title (by whoever wrote it) and history are
  // one commit, through the fork's cell: a fork exists with its history or
  // not at all.
  const cell = yield* (yield* RunHistory).open(runId, {
    registration: Effect.succeed(
      title === null
        ? rows
        : [...rows, descriptionRow(runId, title.description, title.by)],
    ),
  });
  yield* cell.append([
    ...viewRows(runId, state, state.messages),
    ...(yield* forkedFacts(from.id, cut, runId)),
    ...(state.backend === null
      ? []
      : [
          configRow(runId, record, record.model, {
            backend: state.backend,
            declinedRoutes: state.declinedRoutes,
          }),
        ]),
    positionRow(runId, state, 'waiting'),
  ]);
  return runId;
});

/**
 * Conversation `from` as a child of a `self()` call will open on it: the
 * agent configuration it launches with, and the history its opening commits
 * instead of a prompt (`RegisterRunOptions.seed`), its first message ending
 * on `prompt`. The child is launched fresh, never resumed, so it starts
 * with the grants its parent's script holds. The cut is the conversation as
 * it stood before commit `before` (the script's start): the beginning of
 * the turn that issued the script, or the wait before it, so every call of
 * one script forks the same history whatever the conversation does since.
 */
export const forkSeed = Effect.fn('forkSeed')(function* (
  from: RunId,
  before: number,
  runId: RunId,
  prompt: string,
  /** The source's row the child is bound as of (`undefined`: its latest). */
  boundAt: number | undefined,
): Effect.fn.Return<
  {
    readonly record: AgentConfig;
    readonly seed: NonNullable<RegisterRunOptions['seed']>;
  },
  Rejected | Error,
  ForkServices
> {
  const { seq, state, record } = yield* cutOf(from, null, before);
  const text = { kind: 'text' as const, text: prompt };
  // The prompt is the next user message; a cut that already ends on one
  // (a turn's beginning) takes it as that message's last part.
  const last = state.messages.at(-1);
  const messages =
    last?.role === 'user'
      ? [
          ...state.messages.slice(0, -1),
          { ...last, content: [...last.content, text] },
        ]
      : [...state.messages, { role: 'user' as const, content: [text] }];
  // Bound as the source was when it issued the call, not at the cut: a
  // route its turn declined since stays declined (`AgentRun` binds a seeded
  // launch from this row).
  const bound = (yield* (yield* RunHistory).load(from, boundAt)) ?? state;
  const model = bound.modelId ?? record.model;
  const binding =
    bound.backend === null
      ? null
      : { backend: bound.backend, declinedRoutes: bound.declinedRoutes };
  return {
    record: { ...record, model },
    seed: {
      rows: [
        ...viewRows(runId, state, messages),
        ...(yield* forkedFacts(from, seq, runId)),
        ...(binding === null
          ? []
          : [configRow(runId, { ...record, model }, model, binding)]),
      ],
      binding,
    },
  };
});
