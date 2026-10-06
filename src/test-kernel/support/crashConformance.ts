/**
 * The crash-point conformance suite (durable harness, H6): the durability
 * contract checked at every commit point of one run, under the plugin list
 * the importing file installed its process runtime with
 * (`sessionGraphTestSetup` for TeXRA's, `builtinSessionGraphTestSetup` for
 * the harness's built-ins alone).
 *
 * A clean pass drives `golden_crash` (`goldenTurn` in the validation model)
 * in-process over a persistent store: a response with two calls (a read and
 * a command), a script whose nested calls run a read, a command and an
 * awaited `agent()` call that owns its child, the echo's answer, then a
 * handoff and a compaction (`context.edit`) and a fork, and the bash
 * bypass turned on and off again. The pass records the commit each write
 * transaction ended at, from the store's own `observedCommit`: a batch
 * commits whole, so those are the crash points. For each point N the suite
 * copies the clean store, truncates it to commits 1..N (the store a process
 * killed after commit N leaves), hands its claims to a dead owner, opens a
 * fresh session over it and resumes the root run. The handoff, the
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
 * - invariant I9: a bypass turned off is acknowledged before its row is durable (a
 *   resume would restore it on).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { it } from '@effect/vitest';
import {
  Duration,
  Effect,
  Fiber,
  Layer,
  RcMap,
  Stream,
  SubscriptionRef,
} from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';

import { apiKeySecretName } from '@texra-ai/llm';
import { refresh } from '@agent/index';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { resumeRun } from '@agent/runtime/resumeRun';
import { runAgent } from '@agent/runtime/runAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { withProcessServices } from '@platform/processRuntime';
import {
  aggregateTarget,
  type RunEndOutput,
  type RunId,
} from '@shared/schemas';
import { ProjectDatabases } from '@shared/session/database';
import { FakeStateStore } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  fakeHostAgentDirectories,
  fakeHostSecrets,
  setupPlatform,
} from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  closeTestDefaultSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';
import { generateRunId } from '@utils/core';

const AGENTS = resolve(REPO_ROOT, 'src/test-kernel/fixtures/storage/agents');
const BUNDLED_AGENTS = resolve(
  REPO_ROOT,
  'packages/extension/resources/agents',
);
const HANDOFF = 'CRASH-HANDOFF: carry on from here.';
const VALIDATION = {
  TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1',
  TEXRA_CLI_INTERNAL_VALIDATION_MODEL_ENV: 'TEXRA_INTERNAL_VALIDATE_MODEL',
  TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_ENV:
    'TEXRA_INTERNAL_VALIDATE_MODEL_FLAG',
  TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_CONTENT: 'texra-cli-run-validation',
  TEXRA_INTERNAL_VALIDATE_MODEL: '1',
  TEXRA_INTERNAL_VALIDATE_GOLDEN: '1',
  TEXRA_INTERNAL_VALIDATE_ECHO: '1',
};

interface Row {
  readonly commit: number;
  readonly run: string;
  readonly parent: string | null;
  readonly type: string;
  readonly data: string;
}

const rowsOf = (storage: string): Row[] => {
  const db = new DatabaseSync(join(storage, 'texra.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db
      .prepare(
        `SELECT e."commit" AS "commit", s.logical_id AS run,
           (SELECT json_extract(f.data, '$.parent.id') FROM event f
            WHERE f.aggregate = s.id AND f.type = 'run.start') AS parent,
           e.type AS type, e.data AS data
         FROM event e JOIN event_sequence s ON s.id = e.aggregate
         WHERE s.kind = 'run' ORDER BY e."commit"`,
      )
      .all() as unknown as Row[];
  } finally {
    db.close();
  }
};

const json = (row: Row) => JSON.parse(row.data) as Record<string, unknown>;
const payload = (row: Row) => json(row).payload as Record<string, unknown>;
const isResponse = (row: Row) =>
  row.type === 'model.message' && payload(row).kind === 'response';

/** A provider's call ids restart with each model binding, so a resumed
 *  run's differ from the clean run's by their counter; run ids are minted,
 *  and a command's summary names how long it took. */
const normalized = (text: string) =>
  text
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

/** A response's text, or null when it calls tools. */
const answerOf = (row: Row): string | null => {
  const content = (
    payload(row).turn as {
      readonly content: readonly {
        readonly kind: string;
        readonly content?: readonly { readonly text?: string }[];
      }[];
    }
  ).content;
  if (content.some((part) => part.kind === 'local-call')) return null;
  return content
    .flatMap((part) => part.content ?? [])
    .map((part) => part.text ?? '')
    .join('');
};

const answers = (rows: readonly Row[], run: string) =>
  rows.flatMap((row) => {
    const text = row.run === run && isResponse(row) ? answerOf(row) : null;
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
      const { followUpId, control } = json(row) as {
        readonly followUpId: string;
        readonly control?: { readonly kind: string };
      };
      if (control === undefined) return [];
      const consumed = of(root, 'followup.consumed').filter(
        (done) => json(done).followUpId === followUpId,
      );
      return [`${control.kind} consumed ${consumed.length}`];
    }),
    model: of(root, 'run.config')
      .flatMap((row) => [
        (json(row).config as { readonly model: string }).model,
      ])
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
        .map((row) => (json(row).parent as { callId: string }).callId),
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
        (
          payload(row).messages as readonly {
            readonly role: string;
            readonly content?: unknown;
          }[]
        ).map(
          (message) =>
            `${message.role}: ${normalized(textsOf(message.content).join(''))}`,
        ),
      ),
    })),
  };
}

/** Truncate a copy of the clean store to its first `n` commits, as a process
 *  killed after commit `n` leaves it, its claims held by a dead owner. The
 *  projections rebuild from the rows on open. */
function crashAt(clean: string, storage: string, n: number): void {
  mkdirSync(storage, { recursive: true });
  cpSync(clean, join(storage, 'texra.db'));
  const dead = JSON.stringify([
    os.hostname().toLowerCase(),
    process.pid,
    'killed',
  ]);
  const db = new DatabaseSync(join(storage, 'texra.db'));
  try {
    db.exec(`
      DELETE FROM projection_state; DELETE FROM projected_row;
      DELETE FROM listing_entry; DELETE FROM run_usage; DELETE FROM run_model;
      DELETE FROM event_blob WHERE "commit" > ${n};
      DELETE FROM event WHERE "commit" > ${n};
      DELETE FROM event_sequence WHERE id NOT IN (SELECT aggregate FROM event);
      DELETE FROM blob WHERE digest NOT IN (SELECT digest FROM event_blob);
      UPDATE event_sequence SET
        seq = (SELECT max(seq) FROM event WHERE aggregate = event_sequence.id),
        closed_by = CASE WHEN closed_by > ${n} THEN NULL ELSE closed_by END,
        owner_id = CASE WHEN owner_id IS NULL THEN NULL ELSE '${dead}' END;
      UPDATE sqlite_sequence SET seq = ${n} WHERE name = 'event';
    `);
  } finally {
    db.close();
  }
}

/** Approve every request the runs open, those the prefix left pending
 *  included. */
const approveAll = (session: SessionHandle) =>
  Stream.runForEach(
    session.log
      .tail(0)
      .pipe(Stream.filter((event) => event.type === 'request.opened')),
    (event) => {
      if (event.type !== 'request.opened') return Effect.void;
      const target = aggregateTarget(event.aggregateId);
      if (target.kind !== 'run') return Effect.void;
      return session.requests
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
const SWITCH_TO = 'gpt55';

/** Whether the root holds a queued request of `kind`. */
const requested = (rows: readonly Row[], root: string, kind: string) =>
  rows.some(
    (row) =>
      row.run === root &&
      row.type === 'followup.queued' &&
      (json(row).control as { kind?: string } | undefined)?.kind === kind,
  );

/**
 * The user's part, each step issued only if its rows are not committed: a
 * handoff once the run parks, a model switch and a compaction once it has
 * answered the handoff, then, once it has answered from the summary, a fork of the
 * conversation.
 */
const userSteps = (session: SessionHandle, storage: string, root: RunId) =>
  Effect.gen(function* () {
    if (!editsOf(rowsOf(storage), root).includes('handoff')) {
      yield* until(storage, (rows) => parkedAfter(rows, root, 1));
      yield* session.requests.request({
        kind: 'run.reset',
        runId: root,
        handoff: HANDOFF,
      });
    }
    // A switch, then a compaction, each asked for once: a request whose
    // row is committed is the resumed run's to apply.
    if (!requested(rowsOf(storage), root, 'model')) {
      yield* until(storage, (rows) => parkedAfter(rows, root, 2));
      const controls = session.runs.getHandle(root)?.controls;
      if (controls === undefined)
        return yield* Effect.die('the parked run has no live controls');
      yield* controls.switchModel(SWITCH_TO);
    }
    if (!requested(rowsOf(storage), root, 'compact')) {
      yield* until(storage, (rows) => parkedAfter(rows, root, 2));
      yield* session.requests.request({ kind: 'run.compact', runId: root });
    }
    if (!rowsOf(storage).some(isFork)) {
      yield* until(
        storage,
        (rows) =>
          editsOf(rows, root).includes('compaction') &&
          parkedAfter(rows, root, 3),
      );
      yield* session.requests.request({
        kind: 'run.fork',
        runId: root,
        at: null,
      });
    }
    if (bashBypassOf(rowsOf(storage), root) !== 'off') {
      for (const enabled of [true, false]) {
        yield* session.requests.request({
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
  });

/** The root's own bash bypass, as its newest `approval.policy` row says. */
const bashBypassOf = (rows: readonly Row[], root: string) => {
  const row = rows.findLast(
    (row) => row.run === root && row.type === 'approval.policy',
  );
  return row === undefined
    ? undefined
    : (json(row).snapshot as { own: { bash?: string } }).own.bash;
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
    .map(
      (row) =>
        (payload(row).invocation as { invocationId: string }).invocationId,
    );
  const boundTo = new Map(
    final
      .filter((row) => row.type === 'tool.binding')
      .map((row) => [
        String(payload(row).requestId),
        String(payload(row).callId),
      ]),
  );
  const isCommand = (callId: unknown) =>
    /validation-(bash-\d+|script-\d+\/1)$/.test(String(callId));
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
    const decided = json(row) as {
      readonly requestId: string;
      readonly decision: { readonly action: string };
    };
    return decided.decision.action === 'approve'
      ? [{ callId: boundTo.get(decided.requestId), commit: row.commit }]
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
  const callOf = (child: Row) =>
    (json(child).parent as { callId: string }).callId;
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
  // A command whose body the prefix started and never settled is not run
  // again: it settles as outcome unknown, and the model decides. What the
  // conversation settled from there on is then the model's choice, not
  // the clean pass's, so those fields are not compared.
  const isSettled = (callId: unknown) =>
    prefix.some(
      (row) => row.type === 'tool.result' && payload(row).callId === callId,
    );
  const cutShort = prefix.filter(
    (row) =>
      row.type === 'tool.intent' &&
      isCommand(payload(row).callId) &&
      !isSettled(payload(row).callId),
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
  return [
    ...Object.entries(got).map(([field, value]) =>
      modelDecides.has(field) ||
      JSON.stringify(value) ===
        JSON.stringify(expected[field as keyof typeof expected])
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
  launch: (session: SessionHandle) => Effect.Effect<unknown, unknown>,
  steps: (session: SessionHandle) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const points = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openTestDefaultSession({ roots });
        // The session's own store handle: the process holds one per root.
        const databases = yield* withProcessServices(
          testRuntime(),
          Effect.gen(function* () {
            return yield* ProjectDatabases;
          }),
        );
        const db = yield* RcMap.get(databases, roots.storage);
        const commits: number[] = [];
        yield* SubscriptionRef.changes(db.observedCommit).pipe(
          Stream.runForEach((commit) =>
            Effect.sync(() => commits.push(commit)),
          ),
          Effect.forkScoped,
        );
        yield* approveAll(session);
        const run = yield* launch(session).pipe(Effect.forkChild);
        yield* steps(session);
        yield* closeTestDefaultSession;
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
    session: SessionHandle,
    storage: string,
  ) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const storage = join(roots.storage, `crash-${n}`);
    crashAt(clean, storage, n);
    // The files runs keep beside the store outlive the process: a revision's
    // reply is on disk before the row that names it commits.
    const files = join(roots.storage, 'executions');
    if (existsSync(files))
      cpSync(files, join(storage, 'executions'), { recursive: true });
    const prefix = rowsOf(storage);
    const refused = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openTestDefaultSession({
          roots: { ...roots, storage },
        });
        yield* approveAll(session);
        if (!prefix.some((row) => row.run === root && row.type === 'run.end')) {
          const resumed = yield* withProcessServices(
            testRuntime(),
            resumeRun(root, { session }),
          );
          if (!('started' in resumed))
            return `the resume was refused: ${resumed.failed}`;
        }
        yield* steps(session, storage);
        return null;
      }).pipe(
        Effect.ensuring(closeTestDefaultSession),
        Effect.timeout('60 seconds'),
        Effect.catchCause((cause) =>
          Effect.succeed(`the resume stalled: ${String(cause)}`),
        ),
      ),
    );
    return { prefix, final: rowsOf(storage), refused };
  });

export function crashConformanceSuite(plugins: string): void {
  describe(`crash-point conformance (${plugins})`, () => {
    const tempDirs = useTempDirs();
    setupPlatform(async () => {
      const host = await createTempDirPlatform('texra-crash-', tempDirs);
      const agents = {
        custom: () => Effect.succeed(AGENTS),
        customConfigured: () => Effect.succeed(false),
        // The bundled personas, `polish` among them: the golden agents
        // resolve from the custom source first.
        builtIn: () => Effect.succeed(BUNDLED_AGENTS),
        builtInToolUse: () => Effect.succeed(AGENTS),
      };
      return {
        ...host,
        platform: { ...host.platform, agentDirectories: agents },
      };
    });

    let restore: Record<string, string | undefined> = {};
    beforeEach(async () => {
      const { storage, workspace } = testWorkspaceRoots();
      const flag = join(storage, 'validation-flag');
      restore = Object.fromEntries(
        [...Object.keys(VALIDATION), 'TEXRA_INTERNAL_VALIDATE_MODEL_FLAG'].map(
          (key) => [key, process.env[key]],
        ),
      );
      Object.assign(process.env, VALIDATION, {
        TEXRA_INTERNAL_VALIDATE_MODEL_FLAG: flag,
      });
      mkdirSync(storage, { recursive: true });
      mkdirSync(workspace!, { recursive: true });
      writeFileSync(flag, 'texra-cli-run-validation\n');
      writeFileSync(
        join(workspace!, 'notes.tex'),
        '\\section{Notes}\nThe crash suite reads this file.\n',
      );
      await Effect.runPromise(
        Effect.provide(
          refresh(),
          Layer.mergeAll(
            unusedGlobalStorageFs(),
            nodePlatformLayer,
            testHttpClientLayer,
            AgentDirectories.layer(fakeHostAgentDirectories),
            AppState.layer(new FakeStateStore()),
          ),
        ),
      );
      // The child's model is chosen among those a key makes available.
      await Effect.runPromise(
        fakeHostSecrets.set(apiKeySecretName('openai'), 'validation-fake-key'),
      );
      await Effect.runPromise(closeTestDefaultSession);
    });
    afterEach(async () => {
      await Effect.runPromise(closeTestDefaultSession);
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it.live(
      'resumes from every commit point to the clean outcome, running nothing twice',
      () =>
        Effect.gen(function* () {
          const roots = testWorkspaceRoots();
          const effectsLog = join(roots.workspace!, 'effects.log');
          const root = generateRunId();

          const { points, clean } = yield* cleanPass(
            roots,
            (session) =>
              withProcessServices(
                testRuntime(),
                runAgent(
                  {
                    config: AgentConfigSchema.parse({
                      agent: 'golden_crash',
                      model: 'gpt56',
                      instruction: 'Work through the crash task.',
                    }),
                    runId: root,
                  },
                  { session },
                ),
              ),
            (session) => userSteps(session, roots.storage, root),
          );
          const cleanRows = rowsOf(roots.storage);
          const expected = outcome(cleanRows, root);
          // The clean pass crossed every boundary the suite names.
          expect(expected).toMatchObject({
            answers: [
              'Model saw: Work through the crash task. (+0)',
              `Model saw: ${HANDOFF} (+0)`,
              'Model saw: [Previous conversation summary]\n\nThe golden chat so far. (+0)',
            ],
            edits: ['handoff', 'compaction'],
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
          // The two calls, the script and its three calls, each settled.
          expect(expected.settled).toHaveLength(6);
          expect(
            [
              'tool.intent',
              'tool.result',
              'script.call',
              'request.decided',
            ].filter((type) => !cleanRows.some((row) => row.type === type)),
          ).toEqual([]);
          expect(
            violations([], cleanRows, 0, root, expected, ['batch', 'script']),
          ).toEqual([]);

          const broken: string[] = [];
          for (const n of points) {
            rmSync(effectsLog, { force: true });
            const { prefix, final, refused } = yield* resumeFrom(
              roots,
              clean,
              n,
              root,
              (session, storage) => userSteps(session, storage, root),
            );
            // No file: no command ran during the resume.
            const effects = existsSync(effectsLog)
              ? readFileSync(effectsLog, 'utf8').split('\n').filter(Boolean)
              : [];
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
     * command's last turn each settle in the batch that ends them, and a
     * resumed parent relays every settled result it has not read. Every
     * crash point after the first settlement resumes the parent until it
     * has read each result its children settled, once. The background
     * script awaits an `agent()` child of its own: a resume never launches
     * that child again for its call (I5).
     */
    it.live(
      'reads every child result settled before the crash, exactly once',
      () =>
        Effect.gen(function* () {
          const roots = testWorkspaceRoots();
          const root = generateRunId();
          /** The deliveries the children settled, by follow-up id. */
          const settled = (rows: readonly Row[]) =>
            rows.flatMap((row) => {
              if (row.type !== 'child.turn') return [];
              const delivery = json(row).delivery as
                | { readonly to: string; readonly followUpId: string }
                | undefined;
              return delivery?.to === root ? [delivery.followUpId] : [];
            });
          const ids = (rows: readonly Row[], type: string) =>
            rows
              .filter((row) => row.run === root && row.type === type)
              .map((row) => String(json(row).followUpId));
          const allRead = (rows: readonly Row[]) => {
            const consumed = new Set(ids(rows, 'followup.consumed'));
            return settled(rows).every((id) => consumed.has(id));
          };
          /** Every result read, and every child the resume launched (a
           *  command it re-ran after its outcome was unknown) settled. */
          const quiet = (rows: readonly Row[], n: number) =>
            allRead(rows) &&
            rows
              .filter(
                (row) =>
                  row.commit > n &&
                  row.type === 'run.start' &&
                  row.parent === root,
              )
              .every((child) =>
                rows.some(
                  (row) =>
                    row.run === child.run &&
                    (row.type === 'run.end' ||
                      (row.type === 'child.turn' &&
                        json(row).phase === 'settled')),
                ),
              );
          const { points, clean } = yield* cleanPass(
            roots,
            (session) =>
              withProcessServices(
                testRuntime(),
                runAgent(
                  {
                    config: AgentConfigSchema.parse({
                      agent: 'golden_delivery',
                      model: 'gpt56',
                      instruction: 'Send the children off.',
                    }),
                    runId: root,
                  },
                  { session },
                ),
              ),
            () =>
              until(
                roots.storage,
                (rows) => settled(rows).length === 3 && allRead(rows),
              ),
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
            const { final, refused } = yield* resumeFrom(
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
                ? [
                    `${row.parent}/${(json(row).parent as { callId: string }).callId}`,
                  ]
                : [],
            );
            const found = [
              ...(refused === null ? [] : [refused]),
              new Set(calls).size === calls.length
                ? null
                : 'a child launched again for its call',
              allRead(final) ? null : 'a settled child result was never read',
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
     * A document task's documents are its recipe script's settled value: a
     * resume from any commit point ends `completed` with the clean run's
     * documents, and a revision whose persona child ended before the crash
     * is not run again. The polish persona and the documents plugin are
     * TeXRA's.
     */
    if (plugins === 'TeXRA plugins')
      it.live(
        "resumes a document task from every commit point to the clean run's documents",
        () =>
          Effect.gen(function* () {
            const roots = testWorkspaceRoots();
            const root = generateRunId();
            writeFileSync(
              join(roots.workspace!, 'paper.tex'),
              '\\section{Draft}\nA short draft.\n',
            );
            // The persona answers with the validation document, not the echo.
            delete process.env.TEXRA_INTERNAL_VALIDATE_ECHO;
            const ended = (storage: string) =>
              until(storage, (rows) =>
                rows.some((row) => row.run === root && row.type === 'run.end'),
              );
            const { points, clean } = yield* cleanPass(
              roots,
              (session) =>
                withProcessServices(
                  testRuntime(),
                  runAgent(
                    {
                      config: AgentConfigSchema.parse(
                        documentTaskConfig({
                          agent: 'polish',
                          agentSource: 'builtIn',
                          model: 'gpt56',
                          instruction: 'Polish the draft.',
                          inputFiles: ['paper.tex'],
                          workingDirectory: roots.workspace,
                        }),
                      ),
                      runId: root,
                    },
                    { session },
                  ),
                ),
              () => ended(roots.storage),
            );
            /** How the root ended, and the documents its end carries. */
            const end = (rows: readonly Row[]) => {
              const row = rows.find(
                (row) => row.run === root && row.type === 'run.end',
              );
              if (row === undefined) return null;
              const { outcome, output } = json(row) as {
                readonly outcome: string;
                readonly output: RunEndOutput;
              };
              return {
                outcome,
                outputs: (output.documents?.outputs ?? []).map(
                  (file) => `${file.round} ${file.relativePath}`,
                ),
              };
            };
            const cleanRows = rowsOf(roots.storage);
            const expected = end(cleanRows);
            const childCalls = (rows: readonly Row[]) =>
              rows
                .filter(
                  (row) => row.type === 'run.start' && row.parent === root,
                )
                .map((row) => (json(row).parent as { callId: string }).callId);
            // Two revisions, each its own persona child, and both documents.
            expect(expected).toEqual({
              outcome: 'completed',
              outputs: expect.arrayContaining([expect.any(String)]),
            });
            expect(new Set(childCalls(cleanRows)).size).toBe(2);

            const broken: string[] = [];
            for (const n of points) {
              const { prefix, final, refused } = yield* resumeFrom(
                roots,
                clean,
                n,
                root,
                (_, storage) => ended(storage),
              );
              // A call whose child ended before the crash.
              const endedBefore = new Set(
                prefix
                  .filter(
                    (row) => row.type === 'run.start' && row.parent === root,
                  )
                  .filter((child) =>
                    prefix.some(
                      (row) => row.run === child.run && row.type === 'run.end',
                    ),
                  )
                  .map(
                    (child) =>
                      (json(child).parent as { callId: string }).callId,
                  ),
              );
              const relaunched = childCalls(
                final.filter((row) => row.commit > n),
              ).filter((call) => endedBefore.has(call));
              const got = end(final);
              const found = [
                ...(refused === null ? [] : [refused]),
                JSON.stringify(got) === JSON.stringify(expected)
                  ? null
                  : `the run ended ${JSON.stringify(got)}`,
                relaunched.length === 0
                  ? null
                  : `a settled revision's child launched again: ${relaunched.join(', ')}`,
                new Set(childCalls(final)).size === 2
                  ? null
                  : `the revisions' children came to ${new Set(childCalls(final)).size} calls`,
              ].filter((violation) => violation !== null);
              if (found.length > 0)
                broken.push(`after commit ${n}: ${found.join('; ')}`);
            }
            expect(broken).toEqual([]);
          }),
        600_000,
      );
  });
}
