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
 * handoff and a compaction (`context.edit`) and a fork. The pass records
 * the commit each write transaction ended at, from the store's own
 * `observedCommit`: a batch commits whole, so those are the crash points.
 * For each point N the suite copies the clean store, truncates it to
 * commits 1..N (the store a process killed after commit N leaves), hands
 * its claims to a dead owner, opens a fresh session over it and resumes the
 * root run. The handoff, the compaction and the fork are a user's requests,
 * which a crash loses: they are issued again when their rows are not in the
 * prefix. Every request is approved, and an unfinished call whose outcome
 * is unknown is retried.
 *
 * Failure modes, each checked at every point:
 * - the conversation comes to another end than the clean one: the root's
 *   answers, its view edits, what each executed call returned, its owned
 *   children and their answers, its fork;
 * - a call settled before the crash settles again, or any call twice; an
 *   unfinished command runs again without a person's retry;
 * - a command's side effect (the line it appends) happens during the resume
 *   with no newly executed command to account for it, or one is missing;
 * - one model invocation is answered twice (a turn paid twice);
 * - an owned child launches again for its call without a person choosing
 *   to retry it, or a child is left without a terminal row;
 * - a fork is left without the history it was registered with;
 * - a text answer any run committed is never finalized for display.
 *
 * The gaps this build has are pinned (`KNOWN_GAPS`), each with the
 * violations it explains, so a fix shows up here as a diff.
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
import {
  initializeDefaultSession,
  teardownDefaultSession,
} from '@agent/runtime/sessionGraph';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { withProcessServices } from '@platform/processRuntime';
import { aggregateTarget, type RunId } from '@shared/schemas';
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
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { generateRunId } from '@utils/core';

const AGENTS = resolve(REPO_ROOT, 'src/test-kernel/fixtures/storage/agents');
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

/**
 * The crash points this build does not yet survive, by what the prefix
 * holds there. Each is a finding of this suite, reported for its own fix:
 * - `registered-without-history`: a run's registration (`run.start`,
 *   `run.config`, `run.activate`) and its first history batch are separate
 *   commits. Killed between them, a launched run is classified finished and
 *   never resumes or ends, and a fork is left with no history (`forkRun`
 *   ends such a fork failed only when the history write fails in-process).
 * - `answer-not-finalized`: a text response commits, then its
 *   `response.finalized` row in a later batch; a resume replays the
 *   committed response without finalizing it, so its answer never reaches
 *   a non-streamed transcript or the history query's `messages` view.
 * - `child-answer-lost`: an awaited child that answered and parked, killed
 *   before its `run.end`, is resumed in band by its call (its turn was
 *   accepted, never settled), runs no turn, and hands the call an empty
 *   response: the parent's script gets `""` for the child's answer.
 * - `compaction-request-lost`: `run.compact` commits the follow-up that
 *   asks for it; the compaction itself is an in-memory flag the turn reads.
 *   Killed between them, the resumed turn sends the request to the model as
 *   a user message and never compacts.
 */
const KNOWN_GAPS = [
  'answer-not-finalized',
  'child-answer-lost',
  'compaction-request-lost',
  'registered-without-history',
];

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

/** The violations each pinned gap explains at a prefix it stands in; any
 *  other violation there still fails. */
const GAP_VIOLATIONS: Record<string, readonly string[]> = {
  'registered-without-history': [
    'the resume was refused: finished',
    'the conversation came to',
  ],
  'answer-not-finalized': ['an answer was never finalized'],
  'child-answer-lost': ['the conversation came to'],
  'compaction-request-lost': ['the conversation came to'],
};

/** Which pinned gap a prefix stands in, if any. */
function gapOf(prefix: readonly Row[], root: string): string | null {
  const started = prefix.filter((row) => row.type === 'run.start');
  if (
    started.some(
      (start) =>
        !prefix.some(
          (row) => row.run === start.run && row.type === 'run.snapshot',
        ),
    )
  )
    return 'registered-without-history';
  const mine = prefix.filter((row) => row.run === root);
  const asked = mine.findLast(
    (row) =>
      row.type === 'model.message' &&
      row.data.includes('The user requested immediate context compaction'),
  );
  if (
    asked !== undefined &&
    !mine.some(
      (row) =>
        row.type === 'context.edit' &&
        row.commit > asked.commit &&
        payload(row).cause === 'compaction',
    )
  )
    return 'compaction-request-lost';
  const runs = [...new Set(prefix.map((row) => row.run))];
  const lastPosition = (run: string) =>
    prefix.findLast((row) => row.run === run && row.type === 'run.position');
  if (
    runs.some((run) => {
      const at = lastPosition(run);
      return (
        prefix.some((row) => row.run === run && row.parent !== null) &&
        at !== undefined &&
        ['waiting', 'halted'].includes(String(payload(at).at)) &&
        !prefix.some((row) => row.run === run && row.type === 'run.end')
      );
    })
  )
    return 'child-answer-lost';
  if (
    runs.some((run) => {
      const at = lastPosition(run);
      const response = prefix.findLast(
        (row) => row.run === run && isResponse(row),
      );
      return (
        at !== undefined &&
        payload(at).at === 'response.ready' &&
        response !== undefined &&
        answerOf(response) !== null
      );
    })
  )
    return 'answer-not-finalized';
  return null;
}

/** Answer every request the runs open, those the prefix left pending
 *  included: approve, and retry an unfinished call whose outcome is
 *  unknown. */
const approveAll = (session: SessionHandle) =>
  Stream.runForEach(
    session.events
      .all(0)
      .pipe(Stream.filter((event) => event.type === 'request.opened')),
    (event) => {
      if (event.type !== 'request.opened') return Effect.void;
      const target = aggregateTarget(event.aggregateId);
      if (target.kind !== 'run') return Effect.void;
      return session
        .decideRequest(
          target.id,
          event.requestId,
          event.payload.kind === 'toolOutcome'
            ? { action: 'retry' }
            : { action: 'approve' },
        )
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

/**
 * The user's part, each step issued only if its rows are not committed: a
 * handoff once the run parks, a compaction once it has answered the
 * handoff, then, once it has answered from the summary, a fork of the
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
    if (!editsOf(rowsOf(storage), root).includes('compaction')) {
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
  });

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
  // A person's retry of a call whose outcome is unknown: the decision's
  // commit, by the tool the question is about and the call it is bound to.
  const questions = new Map(
    final.flatMap((row): [string, string][] => {
      if (row.type !== 'request.opened') return [];
      const opened = json(row) as {
        readonly requestId: string;
        readonly payload: {
          readonly kind: string;
          readonly data: { readonly toolName?: string };
        };
      };
      return opened.payload.kind === 'toolOutcome'
        ? [[opened.requestId, opened.payload.data.toolName ?? '']]
        : [];
    }),
  );
  const boundTo = new Map(
    final
      .filter((row) => row.type === 'tool.binding')
      .map((row) => [
        String(payload(row).requestId),
        String(payload(row).callId),
      ]),
  );
  const retries = final.flatMap((row) => {
    if (row.type !== 'request.decided') return [];
    const decided = json(row) as {
      readonly requestId: string;
      readonly decision: { readonly action: string };
    };
    const tool = questions.get(decided.requestId);
    return tool !== undefined && decided.decision.action === 'retry'
      ? [
          {
            tool,
            callId: boundTo.get(decided.requestId) ?? null,
            commit: row.commit,
          },
        ]
      : [];
  });
  // An unfinished command runs again only once a person chose to retry it.
  const unaskedReruns = resumed.filter(
    (row) =>
      payload(row).disposition === 'executed' &&
      Number(payload(row).attempt) > 1 &&
      /validation-(bash-\d+|script-\d+\/1)$/.test(
        String(payload(row).callId),
      ) &&
      !retries.some(
        (retry) =>
          retry.callId === payload(row).callId && retry.commit < row.commit,
      ),
  );
  // A call's child launches again only after a person chose to retry it.
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
  // Each relaunch of a call needs its own retry of that call before it.
  const unaskedRelaunches = relaunches.filter(
    (child) =>
      retries.filter(
        (retry) =>
          retry.tool === 'agent' &&
          retry.callId === callOf(child) &&
          retry.commit < child.commit,
      ).length <
      relaunches.filter(
        (other) =>
          callOf(other) === callOf(child) && other.commit <= child.commit,
      ).length,
  );
  const got = outcome(final, root);
  // Every run's committed answers, each finalized once.
  const unfinalized = [...new Set(final.map((row) => row.run))].filter(
    (run) =>
      answers(final, run).length !==
      final.filter(
        (row) => row.run === run && row.type === 'response.finalized',
      ).length,
  );
  return [
    JSON.stringify(got) === JSON.stringify(expected)
      ? null
      : `the conversation came to ${JSON.stringify(got)}`,
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
    unaskedReruns.length === 0
      ? null
      : 'an unfinished command ran again with no one asked',
    unaskedRelaunches.length === 0
      ? null
      : 'a child launched again with no one asked',
    children.every((child) =>
      final.some((row) => row.run === child.run && row.type === 'run.end'),
    )
      ? null
      : 'a child was left without a terminal row',
    unfinalized.length === 0 ? null : 'an answer was never finalized',
  ].filter((violation) => violation !== null);
}

export function crashConformanceSuite(plugins: string): void {
  describe(`crash-point conformance (${plugins})`, () => {
    const tempDirs = useTempDirs();
    setupPlatform(async () => {
      const host = await createTempDirPlatform('texra-crash-', tempDirs);
      const agents = {
        custom: () => Effect.succeed(AGENTS),
        customConfigured: () => Effect.succeed(false),
        builtIn: () => Effect.succeed(AGENTS),
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
      await Effect.runPromise(teardownDefaultSession());
    });
    afterEach(async () => {
      await Effect.runPromise(teardownDefaultSession());
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

          // The clean pass, recording where each write transaction ended.
          const points = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* initializeDefaultSession({ roots });
              // The session's own store handle: the process holds one per
              // root.
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
              const config = AgentConfigSchema.parse({
                agent: 'golden_crash',
                model: 'gpt56',
                agentCategory: 'toolUse',
                instruction: 'Work through the crash task.',
              });
              const run = yield* withProcessServices(
                testRuntime(),
                runAgent({ config, runId: root }, { session }),
              ).pipe(Effect.forkChild);
              yield* userSteps(session, roots.storage, root);
              yield* teardownDefaultSession();
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
          {
            const db = new DatabaseSync(join(roots.storage, 'texra.db'));
            try {
              db.exec(`VACUUM INTO '${clean}'`);
            } finally {
              db.close();
            }
          }
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

          const unexplained: string[] = [];
          const gaps = new Set<string>();
          for (const n of points) {
            const storage = join(roots.storage, `crash-${n}`);
            crashAt(clean, storage, n);
            rmSync(effectsLog, { force: true });
            const prefix = rowsOf(storage);
            const refused = yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* initializeDefaultSession({
                  roots: { ...roots, storage },
                });
                yield* approveAll(session);
                if (
                  !prefix.some(
                    (row) => row.run === root && row.type === 'run.end',
                  )
                ) {
                  const resumed = yield* withProcessServices(
                    testRuntime(),
                    resumeRun(root, { session }),
                  );
                  if (!('started' in resumed))
                    return `the resume was refused: ${resumed.failed}`;
                }
                yield* userSteps(session, storage, root);
                return null;
              }).pipe(
                Effect.ensuring(teardownDefaultSession()),
                Effect.timeout('60 seconds'),
                Effect.catchCause((cause) =>
                  Effect.succeed(`the resume stalled: ${String(cause)}`),
                ),
              ),
            );
            // No file: no command ran during the resume.
            const effects = existsSync(effectsLog)
              ? readFileSync(effectsLog, 'utf8').split('\n').filter(Boolean)
              : [];
            const found = [
              ...(refused === null ? [] : [refused]),
              ...violations(
                prefix,
                rowsOf(storage),
                n,
                root,
                expected,
                effects,
              ),
            ];
            if (found.length === 0) continue;
            const gap = gapOf(prefix, root);
            const explained = gap === null ? [] : GAP_VIOLATIONS[gap]!;
            const rest = found.filter(
              (violation) =>
                !explained.some((known) => violation.startsWith(known)),
            );
            if (rest.length > 0)
              unexplained.push(`after commit ${n}: ${rest.join('; ')}`);
            if (gap !== null && rest.length < found.length) gaps.add(gap);
          }
          expect(unexplained).toEqual([]);
          expect([...gaps].sort()).toEqual(KNOWN_GAPS);
        }),
      300_000,
    );
  });
}
