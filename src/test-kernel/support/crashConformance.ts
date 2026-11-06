/**
 * The crash-point conformance suite: the durability
 * contract checked at every commit point of one run, under the harness's
 * built-ins (the block's `SessionGraph` over `HARNESS_APP`): every scenario
 * runs only harness code.
 *
 * A clean pass drives `golden_crash` (`goldenTurn` in the validation model)
 * in-process over a persistent store: a response with two calls (a read and
 * a command), an approved edit of the file the read returned, a script whose
 * nested calls run a read, a command and an
 * awaited `agent()` call that owns its child, the echo's answer, then a
 * compaction (`context.edit`) and a fork, and the bash
 * bypass turned on and off again. The pass records the commit each write
 * transaction ended at, from the store's own `observedCommit`: a batch
 * commits whole, so those are the crash points. For each point N the suite
 * copies the clean store, truncates it to commits 1..N (the store a process
 * killed after commit N leaves), opens a
 * fresh session over it and resumes the root run. The copy is rebuilt as
 * the store stood at commit N (`crashAt`), and the run's files and the
 * workspace's command effects are put back as the clean pass had them at
 * that commit. A truncation cannot place the cut between an external
 * effect and its result, which is the consequential crash; the golden
 * suite's `golden_effect` is a real kill there. The model switch, the
 * compaction, the fork and the bypass changes are a user's requests, which
 * a crash loses: they are issued again when their rows are not in the
 * prefix. Every request is approved, and an unfinished call whose outcome
 * is unknown is retried.
 *
 * Failure modes, each checked at every point:
 * - invariant I1: the conversation comes to another end than the clean one: the root's
 *   answers, its view edits, what each executed call returned, its owned
 *   children and their answers, its fork;
 * - invariant I2: a call settled before the crash settles again, or any call twice;
 * - invariant I4: a command runs before its approval, or an unfinished one again
 *   without a person's retry;
 * - a command's side effect (the line it appends) happens during the resume
 *   with no newly executed command to account for it, or one is missing;
 * - invariant I3: one model invocation has two committed responses;
 * - invariant I5: an owned child launches again for its call without a person choosing
 *   to retry it, or a child is left without a terminal row;
 * - invariant I7: a fork is left without the history it was registered with;
 * - a text answer any run committed is never finalized for display;
 * - invariant I8: a run's halt commits apart from its end (a stopped run that reads as
 *   interrupted, which an automatic resume carries on);
 * - a person is asked whether to run again an awaited child that had
 *   ended cleanly before the crash;
 * - a person is asked whether a command ran that the crash stopped before
 *   its body started (before its approval);
 * - approvals durable: a crash between a request and its answer leaves it
 *   pending, and the resume's answer is to that same request; a crash
 *   between the answer and the body it admits honours that answer. Either
 *   way the attempt never asks again;
 * - an edit of a file the run read before the crash is refused after it as
 *   unread: what a run has read is a fact of its rows, not of the process
 *   that ran the read (#14479);
 * - invariant I9: a bypass turned off is acknowledged before its row is durable (a
 *   resume would restore it on);
 * - a crash inside one publisher job, between two of its appends, leaves
 *   either half on disk (a job is one SQLite transaction).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { layer } from '@effect/vitest';
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  RcMap,
  Schema,
  Stream,
  SubscriptionRef,
  Context,
} from 'effect';
import { describe, expect } from 'vitest';

import { Sessions } from '@texra-ai/harness';
import { GlobalStateKey } from '@texra-ai/harness/schemas';
import { resumeRun } from '@agent/runtime/resumeRun';
import {
  rootRun,
  type SessionOwner,
  type SessionServices,
} from '@agent/runtime/rootLaunch';
import { SessionRequests } from '@agent/runtime/requestPolicy';
import { Runs } from '@agent/runtime/runRegistry';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  aggregateTarget,
  type RunId,
} from '@shared/schemas';
import { ProjectDatabases } from '@shared/session/database';
import { generateRunId } from '@shared/schemas';
import { SessionLog } from '@shared/session/runHistory';
import { Settings } from '@shared/config/settings';
import {
  answerOf,
  crashAt,
  persistentTestSession,
  storedRows as rowsOf,
  type StoredRow as Row,
  validationHost,
} from '@test/support/storeFaults';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

/** A file's lines, none when it is absent. */
const linesOf = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        // Windows' `echo x >> file` writes `x \r\n`.
        .map((line) => line.trimEnd())
        .filter(Boolean)
    : [];
const decodeFields = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Unknown),
);
const json = (row: Row) => decodeFields(JSON.parse(row.data));
const payload = (row: Row) => decodeFields(json(row).payload);
// Decoders of the row fields the suite reads beyond its type.
const followUpOf = Schema.decodeUnknownSync(
  Schema.Struct({
    followUpId: Schema.String,
    control: Schema.optional(Schema.Struct({ kind: Schema.String })),
  }),
);
const configOf = Schema.decodeUnknownSync(
  Schema.Struct({ config: Schema.Struct({ model: Schema.String }) }),
);
const seedOf = Schema.decodeUnknownSync(
  Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.String,
        content: Schema.optional(Schema.Unknown),
      }),
    ),
  }),
);
const policyOf = Schema.decodeUnknownSync(
  Schema.Struct({
    snapshot: Schema.Struct({
      own: Schema.Struct({ bash: Schema.optional(Schema.String) }),
    }),
  }),
);
const invocationOf = Schema.decodeUnknownSync(
  Schema.Struct({
    invocation: Schema.Struct({ invocationId: Schema.String }),
  }),
);
const decisionOf = Schema.decodeUnknownSync(
  Schema.Struct({
    requestId: Schema.String,
    decision: Schema.Struct({ action: Schema.String }),
  }),
);
const intentOf = Schema.decodeUnknownSync(
  Schema.Struct({
    origin: Schema.Struct({ responseId: Schema.optional(Schema.String) }),
    callId: Schema.String,
    attempt: Schema.Number,
  }),
);
const identityOf = Schema.decodeUnknownSync(
  Schema.Struct({ identity: Schema.Struct({ kind: Schema.String }) }),
);
const ownerOf = Schema.decodeUnknownSync(
  Schema.Struct({
    parent: Schema.Struct({
      call: Schema.NullOr(Schema.Struct({ callId: Schema.String })),
    }),
  }),
);
/** The call a child's `run.start` names as its owner, or null. */
const callOf = (child: Row) => ownerOf(json(child)).parent.call?.callId ?? null;
const isResponse = (row: Row) =>
  row.type === 'model.message' && payload(row).kind === 'response';

/** A provider's call ids restart with each model binding, so a resumed
 *  run's differ from the clean run's by their counter; run ids are minted,
 *  a command's summary names how long it took, and what a run has spent
 *  (`spent`) counts the attempts a crash lost. */
const normalized = (text: string) =>
  text
    .replaceAll(/"spent":[\d.e-]+/g, '"spent":0')
    .replaceAll(/validation-([a-z_]+)-\d+/g, 'validation-$1')
    .replaceAll(/[0-9a-f]{12,}/g, 'ID')
    .replaceAll(/, [\d.]+m?s\)/g, ')');
/** Every `text` a message's content holds, however its parts nest. */
const textsOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, field]) =>
    key === 'text' && typeof field === 'string' ? [field] : textsOf(field),
  );
};
const isFork = (row: Row) =>
  row.type === 'run.start' && row.data.includes('"kind":"fork"');

const answers = (rows: readonly Row[], run: string) =>
  rows.flatMap((row) => {
    const text = row.run === run ? answerOf(row) : null;
    return text === null ? [] : [text];
  });

/** What the conversation came to: the same for the clean run and for a
 *  resume from any crash point. */
function outcome(rows: readonly Row[], root: string) {
  const of = (run: string, type: string) =>
    rows.filter((row) => row.run === run && row.type === type);
  return {
    // The echo names the user messages its view held: the first, and how
    // many follow.
    answers: answers(rows, root).map((text) => {
      const [first, ...rest] = text.split(' | ');
      return `${first} (+${rest.length})`;
    }),
    edits: of(root, 'context.edit').map((row) => payload(row).cause),
    // Each request the user made, queued once and consumed once; and the
    // model the run ends on.
    requests: of(root, 'followup.queued').flatMap((row) => {
      const { followUpId, control } = followUpOf(json(row));
      if (control === undefined) return [];
      const consumed = of(root, 'followup.consumed').filter(
        (done) => json(done).followUpId === followUpId,
      );
      return [`${control.kind} consumed ${consumed.length}`];
    }),
    model: of(root, 'run.config')
      .flatMap((row) => [configOf(json(row)).config.model])
      .at(-1),
    // What each executed call returned, by call: a retried call returns
    // what its first attempt would have.
    settled: [
      ...new Set(
        rows
          .filter(
            (row) =>
              row.run === root &&
              row.type === 'tool.result' &&
              payload(row).disposition === 'executed',
          )
          .map(
            (row) =>
              `${normalized(String(payload(row).callId))} ${normalized(
                JSON.stringify(payload(row).result),
              )}`,
          ),
      ),
    ].sort(),
    // The calls that own a child, and what the children answered: a call's
    // retried child is the same call's.
    children: new Set(
      rows
        .filter((row) => row.type === 'run.start' && row.parent === root)
        .map(callOf),
    ).size,
    childAnswers: [
      ...new Set(
        rows
          .filter((row) => row.type === 'run.start' && row.parent === root)
          .flatMap((child) => answers(rows, child.run)),
      ),
    ],
    // A fork's edits, positions, and the view its seed carries: each
    // message's role and text.
    forks: rows.filter(isFork).map((fork) => ({
      edits: of(fork.run, 'context.edit').map((row) => payload(row).cause),
      positions: of(fork.run, 'run.position').map((row) => payload(row).at),
      seed: of(fork.run, 'context.edit').flatMap((row) =>
        seedOf(payload(row)).messages.map(
          (message) =>
            `${message.role}: ${normalized(textsOf(message.content).join(''))}`,
        ),
      ),
    })),
  };
}

/** The suite host's workspace folder: the validation host always opens one. */
const workspaceOf = ({ workspace }: ReturnType<typeof testWorkspaceRoots>) => {
  if (workspace === undefined)
    throw new Error('the crash suite runs in a workspace folder');
  return workspace;
};

/** The files a run keeps beside the store and the workspace files the run
 *  changes (the command effects, the notes it edits), copied as the clean
 *  pass reached commit `n`: what a process killed there left on disk. */
const snapshotOf = (storage: string, n: number) =>
  join(storage, 'snapshots', String(n));
const FILES_BESIDE = ['executions'];
const WORKSPACE_FILES = ['effects.log', 'notes.tex'];
const takeSnapshot = (
  roots: ReturnType<typeof testWorkspaceRoots>,
  n: number,
): void => {
  const to = snapshotOf(roots.storage, n);
  mkdirSync(to, { recursive: true });
  for (const name of FILES_BESIDE) {
    const from = join(roots.storage, name);
    if (existsSync(from)) cpSync(from, join(to, name), { recursive: true });
  }
  for (const name of WORKSPACE_FILES) {
    const from = join(workspaceOf(roots), name);
    if (existsSync(from)) cpSync(from, join(to, name));
  }
};

/** Approve every request the runs open above commit `after`. */
const approveAll = (session: Context.Context<SessionServices>, after = 0) =>
  Stream.runForEach(
    Context.get(session, SessionLog)
      .tail(0)
      .pipe(
        Stream.filter(
          (event) => event.type === 'request.opened' && event.commit > after,
        ),
      ),
    (event) => {
      if (event.type !== 'request.opened') return Effect.void;
      const target = aggregateTarget(event.aggregateId);
      if (target.kind !== 'run') return Effect.void;
      return Context.get(session, SessionRequests)
        .decide(target.id, event.requestId, { action: 'approve' })
        .pipe(Effect.ignore);
    },
  ).pipe(Effect.forkScoped);

/** Wait until `ready` holds of the store's rows. */
const until = (storage: string, ready: (rows: readonly Row[]) => boolean) =>
  Effect.gen(function* () {
    while (!ready(rowsOf(storage))) yield* Effect.sleep(Duration.millis(25));
  }).pipe(Effect.timeout('30 seconds'));

/** The root's view edits, by cause. */
const editsOf = (rows: readonly Row[], root: string) =>
  rows
    .filter((row) => row.run === root && row.type === 'context.edit')
    .map((row) => payload(row).cause);

/** The root parks with `count` answers, after its last view edit. */
const parkedAfter = (rows: readonly Row[], root: string, count: number) => {
  const mine = rows.filter((row) => row.run === root);
  const last = mine.findLast((row) => row.type === 'run.position');
  const edit = mine.findLast((row) => row.type === 'context.edit');
  return (
    answers(mine, root).length >= count &&
    last !== undefined &&
    payload(last).at === 'waiting' &&
    (edit === undefined || edit.commit < last.commit)
  );
};

/** The model the user switches the run to. */
const SWITCH_TO = 'openai/gpt-5.5-2026-04-23';

/** Whether the root holds a queued request of `kind`. */
const requested = (rows: readonly Row[], root: string, kind: string) =>
  rows.some(
    (row) =>
      row.run === root &&
      row.type === 'followup.queued' &&
      followUpOf(json(row)).control?.kind === kind,
  );

/**
 * The user's part, each step issued only if its rows are not committed: a
 * model switch and a compaction once the run parks, then, once it has
 * answered from the summary, a fork of the conversation.
 */
const userSteps = (
  session: Context.Context<SessionServices>,
  storage: string,
  root: RunId,
) =>
  Effect.gen(function* () {
    // A switch, then a compaction, each asked for once: a request whose
    // row is committed is the resumed run's to apply.
    if (!requested(rowsOf(storage), root, 'model')) {
      yield* until(storage, (rows) => parkedAfter(rows, root, 1));
      const controls = Context.get(session, Runs).get(root)?.controls;
      if (controls === undefined)
        return yield* Effect.die('the parked run has no live controls');
      yield* controls.switchModel(SWITCH_TO);
    }
    if (!requested(rowsOf(storage), root, 'compact')) {
      yield* until(storage, (rows) => parkedAfter(rows, root, 1));
      yield* Context.get(session, SessionRequests).request({
        kind: 'run.compact',
        runId: root,
      });
    }
    if (!rowsOf(storage).some(isFork)) {
      yield* until(
        storage,
        (rows) =>
          editsOf(rows, root).includes('compaction') &&
          parkedAfter(rows, root, 2),
      );
      yield* Context.get(session, SessionRequests).request({
        kind: 'run.fork',
        runId: root,
        at: null,
      });
    }
    if (bashBypassOf(rowsOf(storage), root) !== 'off') {
      for (const enabled of [true, false]) {
        yield* Context.get(session, SessionRequests).request({
          kind: 'policy.set',
          change: { field: 'bypass', runId: root, bypass: 'bash', enabled },
        });
        // Acknowledged means durable: a resume restores the bypass from
        // this row, and an "off" lost to a crash would come back on.
        const stored = bashBypassOf(rowsOf(storage), root);
        if (stored !== (enabled ? 'on' : 'off'))
          return yield* Effect.die(
            `the bash bypass was acknowledged ${enabled ? 'on' : 'off'} while its row says ${stored}`,
          );
      }
    }
  }).pipe(Effect.provide(session));

/** The root's own bash bypass, as its newest `approval.policy` row says. */
const bashBypassOf = (rows: readonly Row[], root: string) => {
  const row = rows.findLast(
    (row) => row.run === root && row.type === 'approval.policy',
  );
  return row === undefined ? undefined : policyOf(json(row)).snapshot.own.bash;
};

/** What broke the contract after a resume from commit `n`. */
function violations(
  prefix: readonly Row[],
  final: readonly Row[],
  n: number,
  root: string,
  expected: ReturnType<typeof outcome>,
  effects: readonly string[],
): string[] {
  const key = (row: Row) =>
    `${row.run}/${String(payload(row).responseId)}/${String(payload(row).callId)}`;
  const settledBefore = new Set(
    prefix.filter((row) => row.type === 'tool.result').map(key),
  );
  const results = final.filter((row) => row.type === 'tool.result');
  const resumed = results.filter((row) => row.commit > n);
  // The commands the resume executed, by the effect each appends.
  const commands = resumed
    .filter(
      (row) =>
        payload(row).disposition === 'executed' &&
        /validation-(bash-\d+|script-\d+\/1)$/.test(
          String(payload(row).callId),
        ),
    )
    .map((row) =>
      String(payload(row).callId).includes('script') ? 'script' : 'batch',
    )
    .sort();
  const invocations = final
    .filter(isResponse)
    .map((row) => invocationOf(payload(row)).invocation.invocationId);
  // A call's requests carry ids its attempt derives,
  // `<responseId>/<callId>:<attempt>:<ordinal>`: the attempt is the id
  // without its ordinal.
  const requestIdOf = (row: Row) => String(json(row).requestId);
  const attemptOfRequest = (requestId: string) =>
    requestId.replace(/:\d+$/, '');
  const callOfRequest = (requestId: string) =>
    /^[^/]+\/(.+):\d+:\d+$/.exec(requestId)?.[1];
  // A crash between a request and its answer, or between the answer and
  // the body it admits, loses no person's decision: the resume joins the
  // request the attempt opened, pending or answered, and never asks that
  // attempt again, nor retires what it left pending.
  const askedBefore = new Set(
    prefix
      .filter((row) => row.type === 'request.opened')
      .map((row) => attemptOfRequest(requestIdOf(row))),
  );
  const reasked = final.filter(
    (row) =>
      row.commit > n &&
      row.type === 'request.opened' &&
      askedBefore.has(attemptOfRequest(requestIdOf(row))),
  );
  const decidedIn = (rows: readonly Row[], requestId: string) =>
    rows.find(
      (row) => row.type === 'request.decided' && requestIdOf(row) === requestId,
    );
  const pendingLost = prefix.filter(
    (row) =>
      row.type === 'request.opened' &&
      decidedIn(prefix, requestIdOf(row)) === undefined &&
      decidedIn(final, requestIdOf(row))?.data.includes(
        '"action":"approve"',
      ) !== true,
  );
  const isCommand = (callId: unknown) =>
    /validation-(bash-\d+|script-\d+\/1)$/.test(String(callId));
  // A call whose body changes the world outside the store: a command, or
  // the edit of the notes.
  const isEffectful = (callId: unknown) =>
    isCommand(callId) || /validation-edit_file-\d+$/.test(String(callId));
  // An unfinished command never runs again, whatever a second run would
  // have returned: its outcome is unknown, and the model decides. A body
  // that starts again is a second intent of the call.
  const reruns = final.filter(
    (row) =>
      row.commit > n &&
      row.type === 'tool.intent' &&
      Number(payload(row).attempt) > 1 &&
      isCommand(payload(row).callId),
  );
  // A command runs only once a person approved it, before its result.
  const approvals = final.flatMap((row) => {
    if (row.type !== 'request.decided') return [];
    const decided = decisionOf(json(row));
    return decided.decision.action === 'approve'
      ? [{ callId: callOfRequest(decided.requestId), commit: row.commit }]
      : [];
  });
  const unapproved = resumed.filter(
    (row) =>
      payload(row).disposition === 'executed' &&
      /validation-(bash-\d+|script-\d+\/1)$/.test(
        String(payload(row).callId),
      ) &&
      !approvals.some(
        (approval) =>
          approval.callId === payload(row).callId &&
          approval.commit < row.commit,
      ),
  );
  // A call's child never launches again: one an earlier attempt left
  // answers the call or resumes under its own id.
  const children = final.filter(
    (row) => row.type === 'run.start' && row.parent !== null,
  );
  const relaunches = children.filter((child) =>
    children.some(
      (earlier) =>
        earlier.commit < child.commit && callOf(earlier) === callOf(child),
    ),
  );
  // A run's halt and its end are one fact: a halt committed without its end
  // reads as an interrupted run, which an automatic resume carries on. The
  // prefix ends where a transaction did, so a halt in it has its end too.
  const haltedApart = prefix.filter(
    (row) =>
      row.type === 'run.position' &&
      payload(row).at === 'halted' &&
      !prefix.some(
        (end) =>
          end.type === 'run.end' &&
          end.run === row.run &&
          end.commit > row.commit,
      ),
  );
  const got = outcome(final, root);
  // A command or an edit whose body the prefix started and never settled is
  // not run again: it settles as outcome unknown, and the model decides.
  // What the conversation settled from there on is then the model's choice,
  // not the clean pass's, so those fields are not compared. The exception
  // is a body whose own request still stands (opened in the prefix and
  // undecided there): its attempt re-enters that request and finishes.
  const isSettled = (callId: unknown) =>
    prefix.some(
      (row) => row.type === 'tool.result' && payload(row).callId === callId,
    );
  const standing = (intent: Row) => {
    const { origin, callId, attempt } = intentOf(payload(intent));
    const own = `${origin.responseId ?? ''}/${callId}:${attempt}`;
    return prefix.some(
      (row) =>
        row.type === 'request.opened' &&
        attemptOfRequest(requestIdOf(row)) === own &&
        decidedIn(prefix, requestIdOf(row)) === undefined,
    );
  };
  const cutShort = prefix.filter(
    (row) =>
      row.type === 'tool.intent' &&
      isEffectful(payload(row).callId) &&
      !isSettled(payload(row).callId) &&
      !standing(row),
  );
  const unknownOutcomes = cutShort.filter(
    (intent) =>
      !final.some(
        (row) =>
          row.type === 'tool.result' &&
          payload(row).callId === payload(intent).callId &&
          payload(row).disposition === 'skipped' &&
          JSON.stringify(payload(row).result).includes('outcome is unknown'),
      ),
  );
  const modelDecides = new Set(
    cutShort.length > 0 ? ['settled', 'children', 'childAnswers'] : [],
  );
  // Every run's committed answers, each finalized once.
  const unfinalized = [...new Set(final.map((row) => row.run))].filter(
    (run) =>
      answers(final, run).length !==
      final.filter(
        (row) => row.run === run && row.type === 'response.finalized',
      ).length,
  );
  const expectedFields = new Map(Object.entries(expected));
  return [
    ...Object.entries(got).map(([field, value]) =>
      modelDecides.has(field) ||
      JSON.stringify(value) === JSON.stringify(expectedFields.get(field))
        ? null
        : `the conversation's ${field} came to ${JSON.stringify(value)}`,
    ),
    unknownOutcomes.length === 0
      ? null
      : 'an interrupted command did not settle as outcome unknown',
    resumed.some((row) => settledBefore.has(key(row)))
      ? 'a call settled before the crash settled again'
      : null,
    new Set(results.map(key)).size === results.length
      ? null
      : 'a call settled twice',
    JSON.stringify(effects.toSorted()) === JSON.stringify(commands)
      ? null
      : `the resume's effects ${JSON.stringify(effects)} are not its commands ${JSON.stringify(commands)}`,
    new Set(invocations).size === invocations.length
      ? null
      : 'an invocation was answered twice',
    reruns.length === 0 ? null : 'an unfinished command ran again',
    unapproved.length === 0 ? null : 'a command ran before its approval',
    reasked.length === 0
      ? null
      : 'a call attempt that asked before the crash asked again',
    pendingLost.length === 0
      ? null
      : 'a request the crash left pending was not answered after it',
    relaunches.length === 0 ? null : 'a child launched again',
    children.every((child) =>
      final.some((row) => row.run === child.run && row.type === 'run.end'),
    )
      ? null
      : 'a child was left without a terminal row',
    unfinalized.length === 0 ? null : 'an answer was never finalized',
    haltedApart.length === 0
      ? null
      : 'a run halted in another transaction than its end',
  ].filter((violation) => violation !== null);
}

/**
 * The clean pass: `launch` runs in a fresh session over the store while
 * `steps` play the user's part, recording the commit each write transaction
 * ended at. Resolves to those commits, the crash points, and a copy of the
 * store they index.
 */
const cleanPass = (
  roots: ReturnType<typeof testWorkspaceRoots>,
  launch: (
    session: Context.Context<SessionServices>,
  ) => Effect.Effect<unknown, unknown, SessionOwner>,
  steps: (
    session: Context.Context<SessionServices>,
  ) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const points = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* persistentTestSession(roots);
        // The session's own store handle: the process holds one per root.
        const db = yield* RcMap.get(yield* ProjectDatabases, roots.storage);
        const commits: number[] = [];
        yield* SubscriptionRef.changes(db.observedCommit).pipe(
          Stream.runForEach((commit) =>
            Effect.sync(() => {
              commits.push(commit);
              takeSnapshot(roots, commit);
            }),
          ),
          Effect.forkScoped,
        );
        yield* approveAll(session);
        const run = yield* launch(session).pipe(Effect.forkChild);
        yield* steps(session);
        // Closed before the last commit is read, so what the close commits
        // is a crash point too; the scope then finds it closed.
        yield* Sessions.use((sessions) => sessions.close(roots));
        yield* Fiber.interrupt(run);
        // Every transaction observed, through the store's last commit.
        const last = Math.max(
          ...rowsOf(roots.storage).map((row) => row.commit),
        );
        while (!commits.includes(last))
          yield* Effect.sleep(Duration.millis(10));
        return [...new Set(commits)].filter((commit) => commit > 0);
      }),
    );
    const clean = join(roots.storage, 'clean.db');
    const db = new DatabaseSync(join(roots.storage, 'texra.db'));
    try {
      db.exec(`VACUUM INTO '${clean}'`);
    } finally {
      db.close();
    }
    return { points, clean };
  });

/**
 * A crash after commit `n` of the clean store and its resume: a fresh
 * session over the truncated copy resumes `root` unless it had ended, and
 * `steps` play the user's part again. Resolves to the prefix's rows, the
 * resumed store's, and why the resume was refused or stalled, if it was.
 */
const resumeFrom = (
  roots: ReturnType<typeof testWorkspaceRoots>,
  clean: string,
  n: number,
  root: RunId,
  steps: (
    session: Context.Context<SessionServices>,
    storage: string,
  ) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const storage = join(roots.storage, `crash-${n}`);
    crashAt(clean, storage, n);
    // The files on disk at the cut, never the later run's: a revision's
    // reply is on disk before the row that names it commits.
    const snapshot = snapshotOf(roots.storage, n);
    for (const name of FILES_BESIDE)
      if (existsSync(join(snapshot, name)))
        cpSync(join(snapshot, name), join(storage, name), { recursive: true });
    for (const name of WORKSPACE_FILES) {
      const file = join(workspaceOf(roots), name);
      rmSync(file, { force: true });
      if (existsSync(join(snapshot, name))) cpSync(join(snapshot, name), file);
    }
    const effectsLog = join(workspaceOf(roots), 'effects.log');
    const effectsBefore = linesOf(effectsLog).length;
    const prefix = rowsOf(storage);
    const refused = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* persistentTestSession({ ...roots, storage });
        yield* approveAll(session, n);
        // What the prefix left pending is answered once the resume has
        // activated the request's run: a resume that retired it instead does
        // so as it loads the run, so the answer then finds it cancelled.
        const pending = prefix.filter(
          (row) =>
            row.type === 'request.opened' &&
            !prefix.some(
              (decided) =>
                decided.type === 'request.decided' &&
                json(decided).requestId === json(row).requestId,
            ),
        );
        yield* Effect.forEach(pending, (row) =>
          until(storage, (rows) =>
            rows.some(
              (activate) =>
                activate.commit > n &&
                activate.run === row.run &&
                activate.type === 'run.activate',
            ),
          ).pipe(
            Effect.andThen(
              Context.get(session, SessionRequests)
                // cast: the store's logical id of a run aggregate is its RunId.
                .decide(row.run as RunId, String(json(row).requestId), {
                  action: 'approve',
                }),
            ),
            Effect.ignore,
          ),
        ).pipe(Effect.forkScoped);
        if (!prefix.some((row) => row.run === root && row.type === 'run.end')) {
          const resumed = yield* resumeRun(root, {}).pipe(
            Effect.provide(session),
          );
          if (!('activation' in resumed))
            return `the resume was refused: ${JSON.stringify(resumed)}`;
        }
        yield* steps(session, storage);
        return null;
      }),
    ).pipe(
      Effect.timeout('60 seconds'),
      Effect.catchCause((cause) =>
        Effect.succeed(`the resume stalled: ${String(cause)}`),
      ),
    );
    // What the resume's commands appended after the cut's effects.
    const effects = linesOf(effectsLog).slice(effectsBefore);
    return { prefix, final: rowsOf(storage), refused, effects };
  });

/**
 * The suite's scenarios. Each replays a run from every commit point, tens of
 * seconds apiece, so each runs from its own file: Vitest spreads files, not
 * tests, over its workers and CI shards.
 */
export type CrashScenario = 'resume' | 'child-results';

/** The suite's tests of `scenarios`; the two short ones (a detached
 *  command, one job's appends) run with `child-results`. */
export function crashConformanceSuite(
  scenarios: readonly CrashScenario[],
): void {
  const runs = (scenario: CrashScenario) => scenarios.includes(scenario);
  describe('crash-point conformance', () => {
    // The validation host, with the notes the crash run reads and edits.
    const crashHost = Layer.effectDiscard(
      Effect.map(FakeHost, ({ roots }) =>
        writeFileSync(
          join(workspaceOf(roots), 'notes.tex'),
          '\\section{Notes}\nThe crash suite reads this file.\n',
        ),
      ),
    ).pipe(Layer.provideMerge(validationHost('texra-crash-')));

    layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
      it.layer(crashHost, { buildPerTest: true })((it) => {
        if (runs('resume'))
          it.effect(
            'resumes from every commit point to the clean outcome, running nothing twice',
            () =>
              Effect.gen(function* () {
                const roots = testWorkspaceRoots();
                const root = generateRunId();

                const { points, clean } = yield* cleanPass(
                  roots,
                  (session) =>
                    rootRun({
                      config: Schema.decodeUnknownSync(AgentConfigSchema)({
                        agent: 'golden_crash',
                        model: 'openai/gpt-5.6-sol',
                        instruction: 'Work through the crash task.',
                      }),
                      runId: root,
                      interactive: true,
                    }).pipe(Effect.provide(session)),
                  (session) => userSteps(session, roots.storage, root),
                );
                const cleanRows = rowsOf(roots.storage);
                const expected = outcome(cleanRows, root);
                // The clean pass crossed every boundary the suite names.
                expect(expected).toMatchObject({
                  answers: [
                    'Model saw: Work through the crash task. (+0)',
                    'Model saw: [Previous conversation summary]\n\nThe golden chat so far. (+0)',
                  ],
                  edits: ['compaction'],
                  requests: ['model consumed 1', 'compact consumed 1'],
                  model: SWITCH_TO,
                  children: 1,
                  childAnswers: ['Child result.'],
                  forks: [
                    {
                      edits: ['fork'],
                      positions: ['waiting'],
                      seed: [
                        'user: [Previous conversation summary]\n\nThe golden chat so far.',
                        'assistant: Model saw: [Previous conversation summary]\n\nThe golden chat so far.',
                      ],
                    },
                  ],
                });
                // The root's prompt line and its stage commit with its opening, so
                // no crash point sits between them (the resume never logs it).
                const first = (type: string) =>
                  cleanRows.find((row) => row.run === root && row.type === type)
                    ?.commit ?? 0;
                const traced = Math.max(first('log'), first('stage.start'));
                expect(
                  points.filter(
                    (p) => p >= first('run.position') && p < traced,
                  ),
                ).toEqual([]);
                // The two calls, the edit, the script and its three calls, each
                // settled.
                expect(expected.settled).toHaveLength(7);
                expect(
                  [
                    'tool.intent',
                    'tool.result',
                    'script.call',
                    'request.decided',
                  ].filter(
                    (type) => !cleanRows.some((row) => row.type === type),
                  ),
                ).toEqual([]);
                // The script's `agent()` approval, which its calls share, is the
                // script call's (attempt 0): every crash point while it is pending
                // must resume to that same card, never a second one.
                expect(
                  cleanRows.some(
                    (row) =>
                      row.type === 'request.opened' &&
                      /:0:\d+$/.test(String(json(row).requestId)),
                  ),
                ).toBe(true);
                expect(
                  violations([], cleanRows, 0, root, expected, [
                    'batch',
                    'script',
                  ]),
                ).toEqual([]);

                const broken: string[] = [];
                for (const n of points) {
                  const { prefix, final, refused, effects } = yield* resumeFrom(
                    roots,
                    clean,
                    n,
                    root,
                    (session, storage) => userSteps(session, storage, root),
                  );
                  const found = [
                    ...(refused === null ? [] : [refused]),
                    ...violations(prefix, final, n, root, expected, effects),
                  ];
                  if (found.length > 0)
                    broken.push(`after commit ${n}: ${found.join('; ')}`);
                }
                expect(broken).toEqual([]);
              }),
            600_000,
          );
        /**
         * Checks invariant I6: a child's result is never lost or read twice across a crash: a
         * detached child's turn, a background script's and a background
         * command's last turn each settle in the batch that ends them, and that
         * batch's transaction queues the result on the parent's input, so no
         * crash point falls between a child's settlement and its delivery.
         * Every crash point after the first settlement resumes the parent until
         * it has read each result its children settled, once. The background
         * script awaits an `agent()` child of its own: a resume never launches
         * that child again for its call (I5).
         *
         * A child the cut left unfinished (a turn accepted and not settled, or
         * none begun) is a background run whose process died: the parent's
         * resume finishes it, resuming an agent or a script under its own id,
         * and ending a command with a notice that its outcome is unknown. A
         * child left as the cut found it, never resumed and its parent never
         * told, is the failure.
         *
         */
        if (runs('child-results'))
          it.effect(
            'reads every child result settled before the crash, exactly once',
            () =>
              Effect.gen(function* () {
                const roots = testWorkspaceRoots();
                const root = generateRunId();
                const ids = (rows: readonly Row[], type: string) =>
                  rows
                    .filter((row) => row.run === root && row.type === type)
                    .map((row) => String(json(row).followUpId));
                /** The results the children delivered, by follow-up id. */
                const settled = (rows: readonly Row[]) => [
                  ...new Set(
                    ids(rows, 'followup.queued').filter((id) =>
                      id.endsWith(':delivery'),
                    ),
                  ),
                ];
                /** The root's children whose settled turns outnumber, or trail,
                 *  their delivered or held results: a cut between the two. */
                const apart = (rows: readonly Row[]) =>
                  rows
                    .filter(
                      (row) => row.type === 'run.start' && row.parent === root,
                    )
                    .map((child) => child.run)
                    .filter(
                      (child) =>
                        rows.filter(
                          (row) =>
                            row.run === child &&
                            row.type === 'child.turn' &&
                            json(row).phase === 'settled',
                        ).length !==
                        settled(rows).filter((id) => id.startsWith(`${child}:`))
                          .length,
                    );
                const allRead = (rows: readonly Row[]) => {
                  const consumed = new Set(ids(rows, 'followup.consumed'));
                  return settled(rows).every((id) => consumed.has(id));
                };
                /** The root's children a cut at `n` left unfinished: a turn
                 *  accepted and not settled, or none begun and no end, in the
                 *  rows up to `n`. */
                const cutShort = (rows: readonly Row[], n: number) =>
                  rows
                    .filter(
                      (row) =>
                        row.commit <= n &&
                        row.type === 'run.start' &&
                        row.parent === root,
                    )
                    .map((child) => child.run)
                    .filter((child) => {
                      const before = rows.filter(
                        (row) => row.run === child && row.commit <= n,
                      );
                      const turns = (phase: string) =>
                        before.filter(
                          (row) =>
                            row.type === 'child.turn' &&
                            json(row).phase === phase,
                        ).length;
                      const accepted = turns('accepted');
                      return (
                        accepted > turns('settled') ||
                        (accepted === 0 &&
                          !before.some((row) => row.type === 'run.end'))
                      );
                    });
                /** Whether `child` settled a turn or ended after commit `after`. */
                const finished = (
                  rows: readonly Row[],
                  child: string,
                  after: number,
                ) =>
                  rows.some(
                    (row) =>
                      row.run === child &&
                      row.commit > after &&
                      (row.type === 'run.end' ||
                        (row.type === 'child.turn' &&
                          json(row).phase === 'settled')),
                  );
                /** Every result read, every held child ended, every child the
                 *  cut left unfinished finished after it, and every child the
                 *  resume launched (a command it re-ran after its outcome was
                 *  unknown) settled. */
                const quiet = (rows: readonly Row[], n: number) =>
                  allRead(rows) &&
                  cutShort(rows, n).every((child) =>
                    finished(rows, child, n),
                  ) &&
                  rows
                    .filter(
                      (row) =>
                        row.commit > n &&
                        row.type === 'run.start' &&
                        row.parent === root,
                    )
                    .every((child) => finished(rows, child.run, 0));
                const { points, clean } = yield* cleanPass(
                  roots,
                  (session) =>
                    rootRun({
                      config: Schema.decodeUnknownSync(AgentConfigSchema)({
                        agent: 'golden_delivery',
                        model: 'openai/gpt-5.6-sol',
                        instruction: 'Send the children off.',
                      }),
                      runId: root,
                      interactive: true,
                    }).pipe(Effect.provide(session)),
                  () =>
                    Effect.gen(function* () {
                      yield* until(
                        roots.storage,
                        (rows) => settled(rows).length === 3 && allRead(rows),
                      );
                    }),
                );
                const cleanRows = rowsOf(roots.storage);
                // The child's turn, the script and the command each reported, and
                // the script's own `agent()` child ran under it.
                expect(settled(cleanRows)).toHaveLength(3);
                expect(
                  cleanRows.filter(
                    (row) =>
                      row.type === 'run.start' &&
                      row.parent !== null &&
                      row.parent !== root,
                  ),
                ).toHaveLength(1);

                const first = Math.min(
                  ...cleanRows
                    .filter((row) => settled([row]).length > 0)
                    .map((row) => row.commit),
                );
                const broken: string[] = [];
                for (const n of points.filter((point) => point >= first)) {
                  const { prefix, final, refused } = yield* resumeFrom(
                    roots,
                    clean,
                    n,
                    root,
                    (_, storage) => until(storage, (rows) => quiet(rows, n)),
                  );
                  const twice = (type: string) =>
                    ids(final, type).filter(
                      (id, index, all) => all.indexOf(id) !== index,
                    );
                  const calls = final.flatMap((row) =>
                    row.type === 'run.start' && row.parent !== null
                      ? [`${row.parent}/${callOf(row)}`]
                      : [],
                  );
                  const found = [
                    ...(refused === null ? [] : [refused]),
                    apart(prefix).length === 0
                      ? null
                      : 'a child settled a turn in another transaction than its delivery',
                    new Set(calls).size === calls.length
                      ? null
                      : 'a child launched again for its call',
                    allRead(final)
                      ? null
                      : 'a settled child result was never read',
                    cutShort(prefix, n).every((child) =>
                      finished(final, child, n),
                    )
                      ? null
                      : 'a child the crash cut short was neither resumed nor reported',
                    twice('followup.queued').length === 0
                      ? null
                      : 'a child result was queued twice',
                    twice('followup.consumed').length === 0
                      ? null
                      : 'a child result was read twice',
                  ].filter((violation) => violation !== null);
                  if (found.length > 0)
                    broken.push(`after commit ${n}: ${found.join('; ')}`);
                }
                expect(broken).toEqual([]);
              }),
            600_000,
          );
        /**
         * A background command its stopped parent let go (a detach) has no
         * parent to finish it when the process running it dies: the next open
         * ends it once, failed with its outcome unknown, never runs it again,
         * and lets its claim go. Parentless is not unowned: a command another
         * live process still runs is left as it stands.
         *
         * The clean pass sends two commands to the background, each waiting for
         * a release that never comes, then stops their parent, keeping them
         * running. The cut is the last commit before the session's close ends
         * them: the parent has ended and the commands run detached. The first,
         * which the open reaches first, is the control, its claim a live
         * process's; the second's owner died.
         */
        if (runs('child-results'))
          it.effect(
            'ends a detached command a dead process left running, once',
            () =>
              Effect.gen(function* () {
                const roots = testWorkspaceRoots();
                const root = generateRunId();
                const SEND = 'Run in the background.';
                const of = (rows: readonly Row[], run: string, type: string) =>
                  rows.filter((row) => row.run === run && row.type === type);
                /** The root's background commands, in launch order. */
                const commands = (rows: readonly Row[]) =>
                  rows
                    .filter(
                      (row) =>
                        row.type === 'run.start' &&
                        row.parent === root &&
                        identityOf(json(row)).identity.kind === 'process',
                    )
                    // cast: the store's logical id of a run aggregate is its RunId.
                    .map((row) => row.run as RunId);
                const began = (rows: readonly Row[]) =>
                  commands(rows).filter((run) =>
                    of(rows, run, 'child.turn').some(
                      (row) => json(row).phase === 'accepted',
                    ),
                  ).length;
                const { points, clean } = yield* cleanPass(
                  roots,
                  (session) =>
                    rootRun({
                      config: Schema.decodeUnknownSync(AgentConfigSchema)({
                        agent: 'golden_script',
                        model: 'openai/gpt-5.6-sol',
                        instruction: SEND,
                      }),
                      runId: root,
                      interactive: true,
                    }).pipe(Effect.provide(session)),
                  (session) =>
                    Effect.gen(function* () {
                      const requests = Context.get(session, SessionRequests);
                      yield* until(roots.storage, (rows) =>
                        parkedAfter(rows, root, 1),
                      );
                      yield* requests.request({
                        kind: 'followUp.send',
                        runId: root,
                        text: SEND,
                      });
                      yield* until(
                        roots.storage,
                        (rows) =>
                          parkedAfter(rows, root, 2) && began(rows) === 2,
                      );
                      // A user's stop detaches the background command under
                      // "Keep agents running".
                      yield* Settings.set(
                        roots,
                        GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
                        true,
                      );
                      yield* requests.request({
                        kind: 'run.stop',
                        runId: root,
                        reason: 'user',
                      });
                      yield* until(
                        roots.storage,
                        (rows) =>
                          of(rows, root, 'run.end').length > 0 &&
                          commands(rows).every(
                            (run) => of(rows, run, 'run.detach').length > 0,
                          ),
                      );
                    }).pipe(Effect.provide(session)),
                );
                const cleanRows = rowsOf(roots.storage);
                expect(commands(cleanRows)).toHaveLength(2);
                const [control, detached] = commands(cleanRows);
                if (control === undefined || detached === undefined)
                  return yield* Effect.die('the clean pass sent no commands');
                // The cut: the parent ended, both commands run detached, neither
                // has ended yet.
                const ended = cleanRows.filter(
                  (row) =>
                    (row.run === control || row.run === detached) &&
                    row.type === 'run.end',
                );
                const n = Math.max(
                  ...points.filter((point) =>
                    ended.every((row) => point < row.commit),
                  ),
                );
                const storage = join(roots.storage, 'crash-detached');
                crashAt(clean, storage, n);
                const reopened = yield* Effect.scoped(
                  Effect.gen(function* () {
                    yield* persistentTestSession({ ...roots, storage });
                    const isEnded = (rows: readonly Row[]) =>
                      [control, detached].every(
                        (run) => of(rows, run, 'run.end').length > 0,
                      );
                    const closed = yield* Effect.exit(until(storage, isEnded));
                    return { released: Exit.isSuccess(closed) };
                  }),
                );
                const final = rowsOf(storage);
                const after = (run: RunId) =>
                  final.filter((row) => row.run === run && row.commit > n);
                expect(reopened.released).toBe(true);
                // Both commands the dead process left running end failed,
                // once, with the notice; neither runs again: no turn begun
                // after the cut, no run launched.
                for (const run of [control, detached]) {
                  expect(
                    of(final, run, 'run.end').map((row) => json(row).outcome),
                  ).toEqual(['failed']);
                  expect(
                    of(after(run), run, 'run.report').map((row) =>
                      String(json(row).report),
                    ),
                  ).toEqual([
                    expect.stringContaining('its outcome is unknown'),
                  ]);
                  expect(
                    after(run).filter(
                      (row) =>
                        row.type === 'child.turn' &&
                        json(row).phase === 'accepted',
                    ),
                  ).toEqual([]);
                }
                expect(
                  final.filter(
                    (row) => row.commit > n && row.type === 'run.start',
                  ),
                ).toEqual([]);
              }),
            600_000,
          );
        /**
         * A job's appends commit together: a process killed between two of them
         * leaves neither on disk. The cut is the store's files copied while the
         * job holds its transaction open, which is what a kill there leaves.
         */
        if (runs('child-results'))
          it.effect(
            'a crash between two appends of one job leaves neither',
            () =>
              Effect.gen(function* () {
                const roots = testWorkspaceRoots();
                const session = yield* persistentTestSession(roots);
                const run = qualifyAggregateId('run', generateRunId());
                const titled = (description: string) => [
                  {
                    type: 'run.description' as const,
                    aggregateId: run,
                    description,
                    by: 'user' as const,
                  },
                ];
                yield* Context.get(session, SessionLog).transact([
                  {
                    type: 'run.start',
                    aggregateId: run,
                    identity: { kind: 'agent', agent: 'chat' },
                    userFollowUpSupport: 'unsupported',
                    parent: null,
                    provenance: null,
                  },
                ]);
                const cut = join(roots.storage, 'cut');
                yield* Context.get(session, SessionLog).transact((tx) =>
                  Effect.gen(function* () {
                    yield* tx.append(titled('first half'));
                    yield* Effect.sync(() => {
                      mkdirSync(cut);
                      for (const file of ['texra.db', 'texra.db-wal'])
                        cpSync(join(roots.storage, file), join(cut, file));
                    });
                    yield* tx.append(titled('second half'));
                  }),
                );
                const types = (storage: string) =>
                  rowsOf(storage).map((row) => row.type);
                expect(types(cut)).toEqual(['run.start']);
                expect(types(roots.storage)).toEqual([
                  'run.start',
                  'run.description',
                  'run.description',
                ]);
              }),
          );
      });
    });
  });
}
