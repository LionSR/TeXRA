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
 * handoff (`context.edit`) and a fork. The pass records the commit each
 * write transaction ended at, from the store's own `observedCommit`: a
 * batch commits whole, so those are the crash points. For each point N the
 * suite copies the clean store, truncates it to commits 1..N (the store a
 * process killed after commit N leaves), hands its claims to a dead owner,
 * opens a fresh session over it and resumes the root run. The handoff and
 * the fork are a user's requests, which a crash loses: they are issued
 * again when their rows are not in the prefix. Every request is approved,
 * and an unfinished call whose outcome is unknown is retried.
 *
 * Failure modes, each checked at every point:
 * - the conversation comes to another end than the clean one: the root's
 *   answers, its view edits, its owned children, its fork;
 * - a call settled before the crash settles again, or any call twice;
 * - a command's side effect (the line it appends) happens during the resume
 *   with no newly executed command to account for it, or one is missing;
 * - one model invocation is answered twice (a turn paid twice);
 * - an owned child launches again for its call without a person choosing
 *   to retry it, or a child is left without a terminal row;
 * - a fork is left without the history it was registered with;
 * - a text answer the run committed is never finalized for display.
 *
 * Two gaps are pinned (`KNOWN_GAPS`) so a fix shows up here as a diff.
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
 */
const KNOWN_GAPS = ['answer-not-finalized', 'registered-without-history'];

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
    // The calls that own a child: a call's retried child is the same call's.
    children: new Set(
      rows
        .filter((row) => row.type === 'run.start' && row.parent === root)
        .map((row) => (json(row).parent as { callId: string }).callId),
    ).size,
    forks: rows.filter(isFork).map((fork) => ({
      edits: of(fork.run, 'context.edit').map((row) => payload(row).cause),
      positions: of(fork.run, 'run.position').map((row) => payload(row).at),
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
  const position = mine.findLast((row) => row.type === 'run.position');
  const response = mine.findLast(isResponse);
  if (
    position !== undefined &&
    payload(position).at === 'response.ready' &&
    response !== undefined &&
    answerOf(response) !== null
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

/** Wait until the root has answered `count` times and parks. */
const parked = (storage: string, root: string, count: number) =>
  Effect.gen(function* () {
    for (;;) {
      const rows = rowsOf(storage).filter((row) => row.run === root);
      const last = rows.findLast((row) => row.type === 'run.position');
      if (
        answers(rows, root).length >= count &&
        last !== undefined &&
        payload(last).at === 'waiting'
      )
        return;
      yield* Effect.sleep(Duration.millis(25));
    }
  }).pipe(Effect.timeout('30 seconds'));

/** The user's part, each step issued only if its rows are not committed:
 *  a handoff once the run parks, then a fork of the conversation. */
const userSteps = (session: SessionHandle, storage: string, root: RunId) =>
  Effect.gen(function* () {
    if (
      !rowsOf(storage).some(
        (row) => row.run === root && row.type === 'context.edit',
      )
    ) {
      yield* parked(storage, root, 1);
      yield* session.requests.request({
        kind: 'run.reset',
        runId: root,
        handoff: HANDOFF,
      });
    }
    if (!rowsOf(storage).some(isFork)) {
      yield* parked(storage, root, 2);
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
  const children = final.filter(
    (row) => row.type === 'run.start' && row.parent !== null,
  );
  const childCalls = new Set(
    children.map((row) => (json(row).parent as { callId: string }).callId),
  );
  // A child whose rows leave its work unaccounted for is asked about; a
  // retry launches the call's child again.
  const retried = final.filter((row) => {
    if (row.type !== 'request.opened') return false;
    const opened = json(row).payload as {
      readonly kind: string;
      readonly data: { readonly toolName?: string };
    };
    return opened.kind === 'toolOutcome' && opened.data.toolName === 'agent';
  }).length;
  const got = outcome(final, root);
  const finalized = final.filter(
    (row) => row.run === root && row.type === 'response.finalized',
  ).length;
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
    children.length - childCalls.size <= retried
      ? null
      : 'a child launched again with no one asked',
    children.every((child) =>
      final.some((row) => row.run === child.run && row.type === 'run.end'),
    )
      ? null
      : 'a child was left without a terminal row',
    answers(final, root).length === finalized
      ? null
      : 'an answer was never finalized',
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
          expect(expected).toEqual({
            answers: [
              'Model saw: Work through the crash task. (+0)',
              `Model saw: ${HANDOFF} (+0)`,
            ],
            edits: ['handoff'],
            children: 1,
            forks: [{ edits: ['fork'], positions: ['waiting'] }],
          });
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
            if (gap === null)
              unexplained.push(`after commit ${n}: ${found.join('; ')}`);
            else gaps.add(gap);
          }
          expect(unexplained).toEqual([]);
          expect([...gaps].sort()).toEqual(KNOWN_GAPS);
        }),
      300_000,
    );
  });
}
