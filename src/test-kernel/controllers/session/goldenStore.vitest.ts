/**
 * Conformance over the golden 1.0 store
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md`
 * §11): `src/test-kernel/fixtures/storage/golden-1.0.sql`, which the real
 * CLI wrote (`pnpm --filter @texra-ai/cli run golden:store`). Every later
 * build must read it as this one does.
 *
 * Failure modes: a stored row that no longer decodes, or decodes to a
 * verdict; a fold that reads the same rows to a different run or state; a
 * resumed run that sends a request its rows did not record; a projection
 * that rebuilds to other rows than its incremental tables hold; a listing
 * that differs from the fold over the whole history; and a newer or unknown
 * row that blocks more than its own aggregate, lets a claim through, or is
 * rewritten. And a pending approval that does not outlive the process that
 * asked: a resume that cancels it, asks the outcome question instead, opens
 * a second request, or runs the command other than once after the approval.
 * And an `agent` fan-out killed mid-script: a resume that launches the
 * completed child again, launches a second child beside the running one (a
 * new id or a second `run.start`) instead of resuming it, asks about a call
 * whose child exists, or returns without both answers; and a second run of
 * the same script that launches anything instead of reusing both results.
 * And a background script killed while its child ran: a resume that
 * launches its child again, leaves the parent's turn open, delivers no
 * result or more than one, or delivers one without its summary line.
 */
// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, Layer, Stream, SubscriptionRef } from 'effect';
import { afterAll, afterEach, beforeEach, describe, expect } from 'vitest';

import { refresh } from '@agent/index';
import { resumeRun } from '@agent/runtime/resumeRun';
import { finalizeRun } from '@agent/storage/runLifecycle';
import { runLedgerLayer } from '@agent/runtime/RunLedger';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  initializeDefaultSession,
  teardownDefaultSession,
} from '@agent/runtime/sessionGraph';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import { databaseLayer } from '@controllers/session/Database';
import {
  decodeRow,
  EVENT_COLUMNS,
  EVENT_FROM,
} from '@controllers/session/rowCodec';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { withProcessServices } from '@platform/processRuntime';
import { AgentDirectories, AppState } from '@platform/interfaces';
import {
  aggregateId,
  isDisplaySessionEvent,
  ROW_KINDS,
  RUN_OUTCOME,
  RunIdSchema,
  type RunId,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import { RunLedger } from '@shared/session/runLedger';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';
import { parseScriptDeliverySummary } from '@shared/subagentFollowup';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  fakeHostAgentDirectories,
  setupPlatform,
} from '@test/support/setupPlatform';
import { FakeStateStore } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import { autoDecideRequests } from '@test/agent/progressTestUtils';
import { dispatchedChildren, scriptStages } from '@ui/transcript';

const GOLDEN = readFileSync(
  resolve(REPO_ROOT, 'src/test-kernel/fixtures/storage/golden-1.0.sql'),
  'utf8',
);
const SELF = JSON.stringify([
  os.hostname().toLowerCase(),
  process.pid,
  'golden-test',
]);

/** The runs, by the ids the generator normalizes them to, in start order. */
const PARKED = RunIdSchema.parse('a00000000001');
const PARENT = RunIdSchema.parse('a00000000002');
const CHAT = RunIdSchema.parse('a00000000006');
const APPROVAL = RunIdSchema.parse('a00000000007');
const SCRIPTED = RunIdSchema.parse('a00000000008');
const FANOUT = RunIdSchema.parse('a00000000009');
/** The fan-out's children: the first completed, the second ran at the kill. */
const FANNED = RunIdSchema.parse('fab0b830fe15028fb71663a9');
const RUNNING = RunIdSchema.parse('bff84dd3e985d3899c2edfca');
/** The chat that sent a script to the background, the script's run, and
 *  the script's one `agent()` child, which ran at the kill. */
const BACKGROUND = RunIdSchema.parse('a0000000000c');
const SCRIPT_RUN = RunIdSchema.parse('86fd08b3bd174f25f0078221');
const SCRIPT_CHILD = RunIdSchema.parse('905d6e67bdcf8bef0289b566');
const TOMBSTONED = RunIdSchema.parse('a0000000000f');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fresh copy of the golden store, as a session's root holds it. */
function goldenRoot(): string {
  const root = realpathSync.native(
    mkdtempSync(join(os.tmpdir(), 'texra-golden-')),
  );
  roots.push(root);
  const db = new DatabaseSync(join(root, 'texra.db'));
  try {
    db.exec(GOLDEN);
  } finally {
    db.close();
  }
  return root;
}

const raw = <T>(storage: string, read: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(join(storage, 'texra.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return read(db);
  } finally {
    db.close();
  }
};

const substrate = (storage: string) =>
  databaseLayer('persistent').pipe(
    Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
    Layer.provide(ProcessIdentity.layer(SELF)),
    Layer.provide(nodeSpawnerLayer),
    Layer.provide(nodePlatformLayer),
    Layer.fresh,
  );

/** The session graph a renderer folds, over the store at `storage`. */
const graph = (storage: string) =>
  SessionViewService.layer.pipe(
    Layer.provideMerge(sessionInputsLayer),
    Layer.provideMerge(
      sessionEventsLayer.pipe(
        Layer.provideMerge(substrate(storage).pipe(Layer.orDie)),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        LocalRuntimeSource.layer,
        TextChunkSource.layer,
        TranscriptSubscriptions.layer,
      ),
    ),
    Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
    Layer.provide(ProcessIdentity.layer(SELF)),
    Layer.provide(nodePlatformLayer),
  );

/** What a view says of each run, in its order. */
const runsOf = (view: SessionView) =>
  [...view.runs.values()].map((run) => ({
    id: run.id,
    label: run.label,
    category: run.category,
    status: run.status,
    outcome: run.durableOutcome,
    parent: run.parentId,
    children: run.childIds,
    blocked: run.blocked,
  }));

const TABLES = {
  listing_entry: 'SELECT * FROM listing_entry ORDER BY aggregate, key',
  projected_row: 'SELECT * FROM projected_row ORDER BY "commit", type',
  run_usage: 'SELECT * FROM run_usage ORDER BY aggregate',
  run_model: 'SELECT * FROM run_model ORDER BY aggregate',
  projection_state: 'SELECT * FROM projection_state ORDER BY name',
};
const projections = (storage: string) =>
  raw(storage, (db) =>
    Object.fromEntries(
      Object.entries(TABLES).map(([table, sql]) => [
        table,
        db.prepare(sql).all(),
      ]),
    ),
  );

describe('the golden 1.0 store', () => {
  it.effect('decodes every row to an event, and holds what §11 names', () => {
    const storage = goldenRoot();
    const rows = raw(storage, (db) =>
      db
        .prepare(
          `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM} ORDER BY e."commit"`,
        )
        .all(),
    );
    const verdicts = rows.map(decodeRow);
    expect(verdicts.filter((verdict) => verdict._tag !== 'event')).toEqual([]);
    const events = verdicts.flatMap((v) =>
      v._tag === 'event' ? [v.event] : [],
    );
    const types = new Set(events.map((event) => event.type));
    for (const type of [
      'tool.result',
      'request.decided',
      'followup.queued',
      'script.call',
      'context.edit',
      'run.removed',
    ] as const)
      expect(types, type).toContain(type);
    // The chat's `/model` switch: the edit it records, and the snapshots
    // naming the model before and after it; and its `/compact`.
    const chat = aggregateId('run', CHAT);
    expect(
      events.flatMap((event) =>
        event.type === 'context.edit' && event.aggregateId === chat
          ? [event.payload.trigger]
          : [],
      ),
    ).toEqual(['model-switch', 'user']);
    expect([
      ...new Set(
        events.flatMap((event) =>
          event.type === 'run.snapshot' && event.aggregateId === chat
            ? [event.payload.runtime.modelId]
            : [],
        ),
      ),
    ]).toEqual(['openai/gpt-5.6-sol@medium', 'gemini38f']);
    // The plan the chat ran as a goal: the goal plugin's fact, active, then
    // completed.
    expect(
      events.flatMap((event) =>
        event.type === 'plugin.fact' &&
        event.aggregateId === chat &&
        event.plugin === 'goal' &&
        event.kind === 'state'
          ? [(event.value as { active: boolean }).active]
          : [],
      ),
    ).toEqual([true, false]);
    // Context blobs two runs share: one stored value, referenced by rows of
    // two aggregates.
    const shared = raw(storage, (db) =>
      db
        .prepare(
          `SELECT r.digest FROM event_blob r JOIN event e ON e."commit" = r."commit"
           GROUP BY r.digest HAVING count(DISTINCT e.aggregate) > 1`,
        )
        .all(),
    );
    expect(shared.length).toBeGreaterThan(0);
    return Effect.gen(function* () {
      const db = yield* Database;
      expect(yield* db.readBlocked()).toEqual([]);
      expect(yield* db.readAll(0)).toHaveLength(rows.length);
    }).pipe(Effect.provide(substrate(storage)));
  });

  it.effect('folds to the pinned session view and run states', () => {
    const storage = goldenRoot();
    return Effect.gen(function* () {
      const view = yield* SessionViewService;
      yield* SubscriptionRef.changes(view.ref).pipe(
        Stream.takeUntil((v) => v.runs.size > 0),
        Stream.runDrain,
      );
      const folded = yield* SubscriptionRef.get(view.ref);
      const done = { status: 'completed', outcome: 'completed', blocked: null };
      const run = (
        id: string,
        label: string,
        rest: Readonly<Record<string, unknown>> = {},
      ) => ({
        id,
        label,
        category: 'toolUse',
        ...done,
        parent: null,
        children: [],
        ...rest,
      });
      const DELEGATED = 'a00000000000000000000003';
      expect(runsOf(folded)).toEqual([
        // Its owner is on another host, so nothing proves it dead.
        run(PARKED, 'golden_park', { status: 'running', outcome: null }),
        run(PARENT, 'golden_parent', { children: [DELEGATED] }),
        run(DELEGATED, 'golden_child', { parent: PARENT }),
        run('a00000000004', 'review'),
        run('a00000000005', 'review'),
        // The user stopped its held turn with Ctrl-C, then exited.
        run(CHAT, 'golden_chat', { status: 'cancelled', outcome: 'cancelled' }),
        // Killed while its command waited for approval.
        run(APPROVAL, 'golden_approval', { status: 'running', outcome: null }),
        // Killed mid-script, like the parked run.
        run(SCRIPTED, 'golden_script', { status: 'running', outcome: null }),
        // Killed while its second child ran.
        run(FANOUT, 'golden_fanout', {
          status: 'running',
          outcome: null,
          children: [RUNNING, FANNED],
        }),
        run(FANNED, 'golden_child', { parent: FANOUT }),
        run(RUNNING, 'golden_child', {
          parent: FANOUT,
          status: 'running',
          outcome: null,
        }),
        // Its turn ended with the script in the background, and the chat
        // was killed while the script's child ran.
        run(BACKGROUND, 'golden_background', {
          status: 'waiting',
          outcome: null,
          children: [SCRIPT_RUN],
        }),
        run(SCRIPT_RUN, 'Background', {
          parent: BACKGROUND,
          status: 'running',
          outcome: null,
          children: [SCRIPT_CHILD],
        }),
        run(SCRIPT_CHILD, 'golden_child', {
          parent: SCRIPT_RUN,
          status: 'running',
          outcome: null,
        }),
      ]);
      // The approval its process never saw answered, still pending.
      expect(
        folded.requests.map((request) => [request.runId, request.payload.kind]),
      ).toEqual([[APPROVAL, 'bash']]);
      // The message typed behind the stopped turn stays queued for a resume
      // to join. The headless parent holds none: its child's message was
      // refused, since a one-shot run never reads one.
      expect(
        [...folded.queuedFollowUps].map(([id, queued]) => [id, queued.length]),
      ).toEqual([[CHAT, 1]]);
      const ledger = yield* RunLedger;
      const stateOf = (id: RunId) =>
        Effect.map(ledger.load(id), (state) => ({
          at: state?.at,
          phase: state?.phase,
          round: state?.round,
          modelId: state?.modelId,
          messages: state?.messages.map((message) => message.role),
          openAttempt: state?.openAttempt != null,
        }));
      expect(yield* stateOf(PARKED)).toEqual({
        at: 'turn.begin',
        phase: 'model.submitted',
        round: 1,
        modelId: 'openai/gpt-5.6-sol@medium',
        messages: ['user'],
        openAttempt: true,
      });
      expect(yield* stateOf(PARENT)).toEqual({
        at: 'halted',
        phase: 'waiting',
        round: 4,
        modelId: 'openai/gpt-5.6-sol@medium',
        messages: [
          'user',
          ...['assistant', 'tool', 'assistant', 'tool'],
          ...['assistant', 'tool'],
          'assistant',
        ],
        openAttempt: false,
      });
      expect((yield* ledger.load(CHAT))?.modelId).toBe('gemini38f');
    }).pipe(
      Effect.provide(runLedgerLayer.pipe(Layer.provideMerge(graph(storage)))),
      Effect.scoped,
    );
  });

  it.effect(
    'blocks only the aggregates a newer build wrote to, and rewrites nothing',
    () => {
      // A newer build's `model.message` (one version past this build's) on
      // one review run, and a core kind this build lacks on the other, each
      // committed as that build would: the row, its sequence, `stored_kind`.
      const storage = goldenRoot();
      const NEWER = RunIdSchema.parse('a00000000004');
      const UNKNOWN = RunIdSchema.parse('a00000000005');
      raw(storage, (db) => {
        const inject = (run: RunId, type: string, version: number) => {
          const { id, seq } = db
            .prepare('SELECT id, seq FROM event_sequence WHERE logical_id = ?')
            .get(run) as { id: number; seq: number };
          db.prepare(
            `INSERT INTO event (aggregate, seq, type, version, origin, at, data)
             VALUES (?, ?, ?, ?, '["newer-build",1,"later"]', 1767312000000, '{}')`,
          ).run(id, seq + 1, type, version);
          db.prepare('UPDATE event_sequence SET seq = ? WHERE id = ?').run(
            seq + 1,
            id,
          );
          db.prepare(
            `INSERT INTO stored_kind VALUES (?, ?)
             ON CONFLICT (type) DO UPDATE SET version = max(version, excluded.version)`,
          ).run(type, version);
        };
        db.exec('BEGIN');
        inject(NEWER, 'model.message', ROW_KINDS['model.message'].version + 1);
        inject(UNKNOWN, 'golden.unknown', 1);
        db.exec('COMMIT');
      });
      const stored = () =>
        raw(storage, (db) =>
          ['event', 'event_sequence', 'blob', 'event_blob'].map((table) =>
            db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
          ),
        );
      const before = stored();
      return Effect.gen(function* () {
        const view = yield* SessionViewService;
        yield* SubscriptionRef.changes(view.ref).pipe(
          Stream.takeUntil((v) => v.runs.size > 0),
          Stream.runDrain,
        );
        const runs = runsOf(yield* SubscriptionRef.get(view.ref));
        expect(runs.filter((run) => run.blocked !== null)).toEqual([
          expect.objectContaining({ id: NEWER, blocked: 'newer' }),
          expect.objectContaining({ id: UNKNOWN, blocked: 'unknown' }),
        ]);
        expect(
          runs.filter((run) => run.blocked === null).map((run) => run.status),
        ).toEqual([
          'running',
          ...Array.from({ length: 2 }, () => 'completed'),
          'cancelled',
          ...Array.from({ length: 3 }, () => 'running'),
          'completed',
          'running',
          'waiting',
          'running',
          'running',
        ]);
        const db = yield* Database;
        for (const [run, type] of [
          [NEWER, 'model.message'],
          [UNKNOWN, 'golden.unknown'],
        ] as const)
          expect(
            yield* Effect.flip(db.acquireClaims([aggregateId('run', run)])),
          ).toMatchObject({
            _tag: 'DatabaseWriteFailed',
            cause: { _tag: 'DatabaseAggregateBlocked', type },
          });
        expect(stored()).toEqual(before);
      }).pipe(Effect.provide(graph(storage)), Effect.scoped);
    },
  );

  it.effect(
    'rebuilds each projection from zero to its incremental tables',
    () => {
      const storage = goldenRoot();
      const incremental = projections(storage);
      raw(storage, (db) =>
        db.exec(`DELETE FROM projection_state; DELETE FROM projected_row;
        DELETE FROM listing_entry; DELETE FROM run_usage; DELETE FROM run_model;`),
      );
      return Effect.gen(function* () {
        yield* (yield* Database).readListing();
        expect(projections(storage)).toEqual(incremental);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect('lists what the fold over the whole history holds', () => {
    const storage = goldenRoot();
    return Effect.gen(function* () {
      const db = yield* Database;
      const listing = yield* db.readListing();
      const history = yield* Stream.runCollect(db.readDisplay(0));
      const of = (events: readonly (typeof listing)[number][]) => {
        const view = fold(
          emptySessionView('golden'),
          events.filter(isDisplaySessionEvent).map((event) => ({
            _tag: 'event' as const,
            read: 'listing' as const,
            event,
          })),
        );
        return {
          runs: runsOf(view),
          order: view.order,
          requests: view.requests,
          queued: [...view.queuedFollowUps],
        };
      };
      expect(of(listing)).toEqual(of([...history]));
      expect(of(listing).runs.map((run) => run.id)).not.toContain(TOMBSTONED);
    }).pipe(Effect.provide(substrate(storage)));
  });
});

/**
 * The interrupted runs resumed by this build, on the scripted model that
 * wrote them (`goldenTurn`, gated as the package validation gates it). The
 * parked run: the request the resume sends must be the one its rows
 * recorded, down to the address of its recorded context. Under Vitest the
 * invoker also checks, before the request leaves, that the rows rebuild the
 * prepared turn exactly. The script killed mid-run: a resume runs it again
 * from the top, hands its settled call back from its row instead of running
 * it, asks about the call the kill interrupted, and runs the rest.
 */
describe('the interrupted golden runs', () => {
  const AGENTS = resolve(REPO_ROOT, 'src/test-kernel/fixtures/storage/agents');
  const tempDirs = useTempDirs();
  setupPlatform(async () => {
    const host = await createTempDirPlatform('texra-golden-resume-', tempDirs);
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

  const VALIDATION = {
    TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1',
    TEXRA_CLI_INTERNAL_VALIDATION_MODEL_ENV: 'TEXRA_INTERNAL_VALIDATE_MODEL',
    TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_ENV:
      'TEXRA_INTERNAL_VALIDATE_MODEL_FLAG',
    TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_CONTENT:
      'texra-cli-run-validation',
    TEXRA_INTERNAL_VALIDATE_MODEL: '1',
    TEXRA_INTERNAL_VALIDATE_GOLDEN: '1',
  };
  let restore: Record<string, string | undefined> = {};
  let session: SessionHandle;
  beforeEach(async () => {
    const storage = testWorkspaceRoots().storage;
    const flag = join(storage, 'validation-flag');
    restore = Object.fromEntries(
      [...Object.keys(VALIDATION), 'TEXRA_INTERNAL_VALIDATE_MODEL_FLAG'].map(
        (key) => [key, process.env[key]],
      ),
    );
    Object.assign(process.env, VALIDATION, {
      TEXRA_INTERNAL_VALIDATE_MODEL_FLAG: flag,
    });
    cpSync(goldenRoot(), storage, { recursive: true });
    writeFileSync(flag, 'texra-cli-run-validation\n');
    writeFileSync(join(storage, 'golden-park.release'), '');
    writeFileSync(join(storage, 'golden-fanout.release'), '');
    writeFileSync(join(storage, 'golden-background.release'), '');
    // The crash, on this host: an owner whose process identity is gone.
    raw(storage, (db) => {
      const kill = db.prepare(
        'UPDATE event_sequence SET owner_id = ? WHERE logical_id = ?',
      );
      for (const run of [
        PARKED,
        APPROVAL,
        SCRIPTED,
        FANOUT,
        RUNNING,
        BACKGROUND,
        SCRIPT_RUN,
        SCRIPT_CHILD,
      ])
        kill.run(
          JSON.stringify([os.hostname().toLowerCase(), process.pid, 'killed']),
          run,
        );
    });
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
    await Effect.runPromise(teardownDefaultSession());
    session = await Effect.runPromise(
      initializeDefaultSession({ roots: testWorkspaceRoots() }),
    );
  });
  afterEach(async () => {
    await Effect.runPromise(teardownDefaultSession());
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.live('sends the request its rows recorded', () =>
    Effect.gen(function* () {
      const attempts = () =>
        raw(testWorkspaceRoots().storage, (db) =>
          db
            .prepare(
              `SELECT json_extract(e.data, '$.payload.request') AS request,
                 json_extract(e.data, '$.payload.invocation') AS invocation
               FROM event e JOIN event_sequence s ON s.id = e.aggregate
               WHERE s.logical_id = ? AND e.type = 'model.message'
                 AND json_extract(e.data, '$.payload.kind') = 'attempt'
               ORDER BY e."commit"`,
            )
            .all(PARKED),
        );
      const [recorded] = attempts();
      const result = yield* withProcessServices(
        testRuntime(),
        resumeRun(PARKED, { session }),
      );
      // It settles at the idle turn: the resumed call has answered.
      expect(result).toMatchObject({ started: true, outcome: 'waiting' });
      const [, resumed, ...rest] = attempts();
      expect(rest).toEqual([]);
      // The same request, as the same call's next attempt.
      expect(resumed?.request).toBe(recorded?.request);
      expect(JSON.parse(String(resumed?.invocation))).toEqual({
        ...JSON.parse(String(recorded?.invocation)),
        attempt: 2,
      });
    }),
  );

  /**
   * The command approval its killed process never saw answered: the resume
   * re-enters the call, which waits on that same request again rather than
   * on a cancellation or an outcome question, and the approval runs the
   * command exactly once.
   */
  it.live('re-presents the pending approval, and runs it once approved', () =>
    Effect.gen(function* () {
      const { storage, workspace } = testWorkspaceRoots();
      const opened = () =>
        raw(storage, (db) =>
          db
            .prepare(
              `SELECT e.data FROM event e JOIN event_sequence s ON s.id = e.aggregate
               WHERE s.logical_id = ? AND e.type = 'request.opened'
               ORDER BY e."commit"`,
            )
            .all(APPROVAL)
            .map((row) => JSON.parse(String(row.data)).payload.data.requestId),
        );
      const [requestId] = opened();
      expect(requestId).toMatch(/^bash-/);
      // The command runs where the run works: the generator's project, here
      // this test's workspace.
      mkdirSync(workspace!, { recursive: true });
      raw(storage, (db) =>
        db
          .prepare(
            `UPDATE event SET data = replace(data, '/golden/project', ?)
             WHERE type IN ('run.start', 'run.config') AND aggregate =
               (SELECT id FROM event_sequence WHERE logical_id = ?)`,
          )
          .run(workspace!, APPROVAL),
      );
      const resumed = yield* Effect.forkChild(
        withProcessServices(testRuntime(), resumeRun(APPROVAL, { session })),
      );
      // The resume's own activation: the test's killed owner shares this
      // process's pid, so the view can call the run this process's before
      // the resume has taken it, and only an answer after it is the resumed
      // run's to read.
      const activated = () =>
        raw(storage, (db) =>
          db
            .prepare(
              `SELECT count(*) AS n FROM event e JOIN event_sequence s ON s.id = e.aggregate
               WHERE s.logical_id = ? AND e.type = 'run.activate'`,
            )
            .get(APPROVAL),
        )?.n === 2;
      // Re-presented: the run waits on its user, held here, on that request.
      yield* SubscriptionRef.changes(session.view).pipe(
        Stream.takeUntil(
          (view) =>
            view.runs.get(APPROVAL)?.approval === 'own' &&
            view.requests.some((request) => request.requestId === requestId) &&
            activated(),
        ),
        Stream.runDrain,
      );
      expect(
        yield* session.decideRequest(APPROVAL, requestId!, {
          action: 'approve',
        }),
      ).toBe(true);
      expect(yield* Fiber.join(resumed)).toMatchObject({
        started: true,
        outcome: 'waiting',
      });
      expect(opened()).toEqual([requestId]);
      expect(readFileSync(join(workspace!, 'approved.txt'), 'utf8')).toBe(
        'approved\n',
      );
    }),
  );

  it.live('resumes the killed script, replaying its settled call', () =>
    Effect.gen(function* () {
      const { storage, workspace } = testWorkspaceRoots();
      // The command the kill interrupted waits for this file. `notes.tex`
      // is not here: the read that settled before the kill would fail if it
      // ran again.
      if (workspace === undefined) throw new Error('no test workspace');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'golden-script.release'), '');
      // It runs again where the run works: here this test's workspace.
      raw(storage, (db) =>
        db
          .prepare(
            `UPDATE event SET data = replace(data, '/golden/project', ?)
             WHERE type IN ('run.start', 'run.config') AND aggregate =
               (SELECT id FROM event_sequence WHERE logical_id = ?)`,
          )
          .run(workspace, SCRIPTED),
      );
      const asked = autoDecideRequests(session, (opened) => {
        if (opened.payload.kind === 'bash') return { action: 'approve' };
        return opened.payload.kind === 'toolOutcome'
          ? { action: 'retry' }
          : null;
      });
      const result = yield* withProcessServices(
        testRuntime(),
        resumeRun(SCRIPTED, { session }),
      ).pipe(Effect.ensuring(Effect.sync(asked.detach)));
      expect(result).toMatchObject({ started: true, outcome: 'waiting' });
      const payloads = (type: string) =>
        raw(storage, (db) =>
          db
            .prepare(
              `SELECT json_extract(e.data, '$.payload') AS payload
               FROM event e JOIN event_sequence s ON s.id = e.aggregate
               WHERE s.logical_id = ? AND e.type = ? ORDER BY e."commit"`,
            )
            .all(SCRIPTED, type)
            .map(
              (row) =>
                JSON.parse(String(row.payload)) as {
                  readonly callId: string;
                  readonly attempt: number;
                  readonly disposition: string;
                  readonly result: { readonly output?: string };
                  readonly seq: number;
                  readonly toolName: string;
                  readonly phase: string | null;
                },
            ),
        );
      const results = payloads('tool.result');
      const settled = (callId: string) =>
        results
          .filter((row) => row.callId === callId)
          .map(({ attempt, disposition }) => ({ attempt, disposition }));
      // The discovery calls and the read that settled before the kill keep
      // their one row each: the resumed guest was handed their answers.
      for (const seq of [0, 1, 2])
        expect(settled(`validation-script-1/${seq}`)).toEqual([
          { attempt: 1, disposition: 'executed' },
        ]);
      // The command the kill interrupted was asked about, then run again.
      expect(
        asked.opened.filter((opened) => opened.payload.kind === 'toolOutcome'),
      ).toHaveLength(1);
      expect(settled('validation-script-1/3')).toEqual([
        { attempt: 2, disposition: 'executed' },
      ]);
      expect(settled('validation-script-1/4')).toEqual([
        { attempt: 1, disposition: 'executed' },
      ]);
      // The guest issued the calls its rows recorded, and returned what the
      // replayed read and the live calls gave it.
      expect(
        payloads('script.call').map(({ seq, toolName, phase }) => [
          seq,
          toolName,
          phase,
        ]),
      ).toEqual([
        [0, 'searchTools()', 'Gather'],
        [1, 'describeTool()', 'Gather'],
        [2, 'read_file', 'Gather'],
        [3, 'bash', 'Gather'],
        [4, 'read_file', 'Gather'],
      ]);
      const script = results.find(
        (row) => row.callId === 'validation-script-1',
      );
      expect(script).toMatchObject({ attempt: 2, disposition: 'executed' });
      expect(script?.result.output).toContain(
        'The golden store reads this file.',
      );
      expect(script?.result.output).toContain('released');
      expect(script?.result.output).toContain('"found": "read_file"');
      expect(script?.result.output).toContain('"documented": true');
    }),
  );

  /**
   * The fan-out killed while its second child ran. The resume runs the
   * script from the top: the call whose child completed is handed back from
   * its row, and the call whose child was running finds that child and
   * resumes it under its own id, asking nobody. Then the model runs the same
   * script in a new call, whose two calls reuse those results.
   */
  it.live(
    'resumes the killed fan-out from its child, reattaching it, then reuses',
    () =>
      Effect.gen(function* () {
        const { storage, workspace } = testWorkspaceRoots();
        if (workspace === undefined) throw new Error('no test workspace');
        mkdirSync(workspace, { recursive: true });
        raw(storage, (db) =>
          db
            .prepare(
              `UPDATE event SET data = replace(data, '/golden/project', ?)
             WHERE type IN ('run.start', 'run.config') AND aggregate IN
               (SELECT id FROM event_sequence WHERE logical_id IN (?, ?, ?))`,
            )
            .run(workspace, FANOUT, FANNED, RUNNING),
        );
        // Before the resume the run is interrupted (its owner proved dead):
        // nothing works on the call whose child was running, so it reads as
        // interrupted, not running, under no Running section.
        yield* session.setTranscriptSubscriptions('golden-test', [
          { id: FANOUT, fromSeq: 0 },
        ]);
        const [killed] = yield* SubscriptionRef.changes(session.view).pipe(
          Stream.filter((view) => {
            const run = view.runs.get(FANOUT);
            return (
              run?.group === 'interrupted' &&
              scriptStages(run, view).length === 1
            );
          }),
          Stream.take(1),
          Stream.runCollect,
        );
        const interrupted = killed!.runs.get(FANOUT)!;
        expect(
          scriptStages(interrupted, killed!)[0]!.calls.map(
            ({ label, status, section, line }) => ({
              label,
              status,
              section: section ?? null,
              line: line.split(' · ')[0],
            }),
          ),
        ).toEqual([
          {
            label: 'A',
            status: 'finished',
            section: null,
            line: 'Finished: A',
          },
          {
            label: 'B',
            status: 'interrupted',
            section: null,
            line: 'Interrupted: B',
          },
        ]);
        yield* session.setTranscriptSubscriptions('golden-test', []);
        const count = (run: RunId, type: string) =>
          Number(
            raw(storage, (db) =>
              db
                .prepare(
                  `SELECT count(*) AS n FROM event e
                 JOIN event_sequence s ON s.id = e.aggregate
                 WHERE s.logical_id = ? AND e.type = ?`,
                )
                .get(run, type),
            )?.n,
          );
        // HQ6: the parent cannot end while its open call owns the child the
        // kill left running.
        const ended = yield* finalizeRun(session, {
          runId: FANOUT,
          outcome: RUN_OUTCOME.COMPLETED,
        });
        expect(ended.ok ? null : String(ended.error)).toContain(
          `owns run ${RUNNING}`,
        );
        expect(count(FANOUT, 'run.end')).toBe(0);
        const asked = autoDecideRequests(session, (opened) =>
          opened.payload.kind === 'proposal' ? { action: 'approve' } : null,
        );
        // Resuming the owned child resumes its parent, whose call
        // reattaches it.
        const result = yield* withProcessServices(
          testRuntime(),
          resumeRun(RUNNING, { session }),
        ).pipe(Effect.ensuring(Effect.sync(asked.detach)));
        expect(result).toMatchObject({ started: true, outcome: 'waiting' });
        expect(count(FANOUT, 'run.activate')).toBe(2);
        // No child was launched again: the two the kill left, each started
        // once; the completed one never ran again, the running one resumed.
        expect(
          raw(storage, (db) =>
            db
              .prepare(
                `SELECT s.logical_id AS id FROM event e
               JOIN event_sequence s ON s.id = e.aggregate
               WHERE e.type = 'run.start'
                 AND json_extract(e.data, '$.parent.id') = ?
               ORDER BY e."commit"`,
              )
              .all(FANOUT)
              .map((row) => row.id),
          ),
        ).toEqual([FANNED, RUNNING]);
        expect([FANNED, RUNNING].map((run) => count(run, 'run.start'))).toEqual(
          [1, 1],
        );
        expect(
          [FANNED, RUNNING].map((run) => count(run, 'run.activate')),
        ).toEqual([1, 2]);
        const results = raw(storage, (db) =>
          db
            .prepare(
              `SELECT json_extract(e.data, '$.payload') AS payload
             FROM event e JOIN event_sequence s ON s.id = e.aggregate
             WHERE s.logical_id = ? AND e.type = 'tool.result'
             ORDER BY e."commit"`,
            )
            .all(FANOUT)
            .map(
              (row) =>
                JSON.parse(String(row.payload)) as {
                  readonly responseId: string;
                  readonly callId: string;
                  readonly attempt: number;
                  readonly disposition: string;
                  readonly result: {
                    readonly output?: string;
                    readonly reusedFrom?: string;
                  };
                },
            ),
        );
        const [first, second] = [
          ...new Set(results.map((row) => row.responseId)),
        ];
        const of = (responseId: string | undefined) =>
          results.filter((row) => row.responseId === responseId);
        const script = (responseId: string | undefined) =>
          of(responseId).find((row) => !row.callId.includes('/'));
        const nested = (responseId: string | undefined) =>
          of(responseId)
            .filter((row) => row.callId.includes('/'))
            .map(({ callId, attempt, disposition, result: settled }) => ({
              seq: callId.split('/').at(-1),
              attempt,
              disposition,
              reusedFrom: settled.reusedFrom?.split('/').at(-1) ?? null,
            }));
        // The call settled before the kill keeps its one row; the running
        // one settles at its next attempt, from the same child.
        expect(nested(first)).toEqual([
          { seq: '0', attempt: 1, disposition: 'executed', reusedFrom: null },
          { seq: '1', attempt: 2, disposition: 'executed', reusedFrom: null },
        ]);
        expect(script(first)).toMatchObject({
          attempt: 2,
          disposition: 'executed',
        });
        for (const answer of [
          'Fan-out child A answer.',
          'Fan-out child B answer.',
        ])
          for (const responseId of [first, second])
            expect(script(responseId)?.result.output).toContain(answer);
        // The same script in a new call: both calls reuse, nothing launches.
        expect(nested(second)).toEqual([
          { seq: '0', attempt: 1, disposition: 'executed', reusedFrom: '0' },
          { seq: '1', attempt: 1, disposition: 'executed', reusedFrom: '1' },
        ]);
        // Nothing was asked: the resumed child was approved when it
        // launched, and a reused call runs nothing.
        expect(asked.opened.map((opened) => opened.payload.kind)).toEqual([]);
        // What every host paints of the two scripts (`scriptStages`): each
        // call under its phase, the first script's linked to the child its
        // card launched (the one launched before the kill included), the
        // second's reused with no child of their own.
        yield* session.setTranscriptSubscriptions('golden-test', [
          { id: FANOUT, fromSeq: 0 },
        ]);
        const [painted] = yield* SubscriptionRef.changes(session.view).pipe(
          Stream.filter((view) => {
            const run = view.runs.get(FANOUT);
            return run !== undefined && scriptStages(run, view).length === 2;
          }),
          Stream.take(1),
          Stream.runCollect,
        );
        const fanout = painted!.runs.get(FANOUT)!;
        expect(
          scriptStages(fanout, painted!).map((stage) =>
            stage.calls.map(({ label, status, phase, childRunId }) => ({
              label,
              status,
              phase,
              childRunId: childRunId ?? null,
            })),
          ),
        ).toEqual([
          [
            {
              label: 'A',
              status: 'finished',
              phase: 'Fan out',
              childRunId: FANNED,
            },
            {
              label: 'B',
              status: 'finished',
              phase: 'Fan out',
              childRunId: RUNNING,
            },
          ],
          [
            {
              label: 'A',
              status: 'reused',
              phase: 'Fan out',
              childRunId: null,
            },
            {
              label: 'B',
              status: 'reused',
              phase: 'Fan out',
              childRunId: null,
            },
          ],
        ]);
        // The stage is the children's one home: the dispatch card lists no
        // awaited call, and the parent's rows carry no progress line of its
        // children (an awaited child's progress is its card's transient
        // text). Each script's card is named by its title and shows its
        // source as JavaScript.
        expect(dispatchedChildren(fanout, painted!)).toEqual([]);
        expect(
          fanout.transcript.rows.flatMap((row) =>
            row.kind === 'log' && row.text.full.startsWith('Subagent ')
              ? [row.text.full]
              : [],
          ),
        ).toEqual([]);
        expect(
          fanout.transcript.rows.flatMap((row) =>
            row.kind === 'tool' && row.toolUse.toolName === 'script'
              ? [
                  {
                    preview: row.model.headerPreview,
                    language: row.model.sections.map((section) =>
                      section.kind === 'code' ? section.language : section.kind,
                    ),
                  },
                ]
              : [],
          ),
        ).toEqual([
          { preview: 'Fan out', language: ['javascript'] },
          { preview: 'Fan out again', language: ['javascript'] },
        ]);
      }),
  );

  /**
   * The script sent to the background, killed while its one child ran. The
   * parent's turn had ended; `resumeRun` on the script's run replays the
   * script from its rows, its `agent()` call finds the running child and
   * resumes it under its own id, and the parent gets one follow-up: the
   * script's result with its summary line.
   */
  it.live('resumes the killed background script, and reports it once', () =>
    Effect.gen(function* () {
      const { storage, workspace } = testWorkspaceRoots();
      if (workspace === undefined) throw new Error('no test workspace');
      mkdirSync(workspace, { recursive: true });
      raw(storage, (db) =>
        db
          .prepare(
            `UPDATE event SET data = replace(data, '/golden/project', ?)
             WHERE type IN ('run.start', 'run.config') AND aggregate IN
               (SELECT id FROM event_sequence WHERE logical_id IN (?, ?, ?))`,
          )
          .run(workspace, BACKGROUND, SCRIPT_RUN, SCRIPT_CHILD),
      );
      const rows = (run: RunId, type: string) =>
        raw(storage, (db) =>
          db
            .prepare(
              `SELECT e.data FROM event e
               JOIN event_sequence s ON s.id = e.aggregate
               WHERE s.logical_id = ? AND e.type = ? ORDER BY e."commit"`,
            )
            .all(run, type)
            .map((row) => JSON.parse(String(row.data))),
        );
      // The parent's turn ended on the launch: the call returned the run.
      const [launch] = rows(BACKGROUND, 'tool.result');
      expect(launch.payload.result.value).toEqual({ runId: SCRIPT_RUN });
      expect(rows(BACKGROUND, 'run.position').at(-1)?.payload.at).toBe(
        'waiting',
      );
      const asked = autoDecideRequests(session, (opened) =>
        opened.payload.kind === 'proposal' ? { action: 'approve' } : null,
      );
      const result = yield* withProcessServices(
        testRuntime(),
        resumeRun(SCRIPT_RUN, { session }),
      ).pipe(Effect.ensuring(Effect.sync(asked.detach)));
      expect(result).toMatchObject({ started: true, outcome: 'completed' });
      // The child the kill left resumed under its own id: one start, a
      // second activation, nothing launched beside it.
      expect(rows(SCRIPT_CHILD, 'run.start')).toHaveLength(1);
      expect(rows(SCRIPT_CHILD, 'run.activate')).toHaveLength(2);
      expect(rows(SCRIPT_RUN, 'run.start').map((row) => row.identity)).toEqual([
        { kind: 'script', title: 'Background' },
      ]);
      // The script ran again from its rows: its call settled at its next
      // attempt with the child's answer.
      const settled = rows(SCRIPT_RUN, 'tool.result').map(
        ({ payload }) => payload,
      );
      expect(
        settled.map(({ callId, attempt, disposition }) => ({
          callId,
          attempt,
          disposition,
        })),
      ).toEqual([
        { callId: 'script/0', attempt: 2, disposition: 'executed' },
        { callId: 'script', attempt: 2, disposition: 'executed' },
      ]);
      expect(settled.at(-1)?.result.output).toContain(
        'Background child answer.',
      );
      expect(rows(SCRIPT_RUN, 'run.end').at(-1)?.outcome).toBe('completed');
      // The script's run is the parent's dispatched child; the child its
      // `agent()` awaited is the script's, listed by its stage alone.
      yield* session.setTranscriptSubscriptions('golden-test', [
        { id: BACKGROUND, fromSeq: 0 },
        { id: SCRIPT_RUN, fromSeq: 0 },
      ]);
      const [listed] = yield* SubscriptionRef.changes(session.view).pipe(
        Stream.map((view) =>
          [BACKGROUND, SCRIPT_RUN].map((id) => {
            const run = view.runs.get(id);
            return run === undefined || run.transcript.rows.length === 0
              ? null
              : dispatchedChildren(run, view).map((child) => child.id);
          }),
        ),
        Stream.filter((lists) => lists.every((list) => list !== null)),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(listed).toEqual([[SCRIPT_RUN], []]);
      // One follow-up for the parent: the result, with its summary line.
      const delivered = rows(BACKGROUND, 'followup.queued').filter(
        (row) => row.content.from?.runId === SCRIPT_RUN,
      );
      expect(delivered).toHaveLength(1);
      const text = String(delivered[0]?.content.text);
      expect(text).toMatch(/^<script-result id="86fd08b3bd174f25f0078221"/);
      expect(text).toContain('Background child answer.');
      expect(parseScriptDeliverySummary(text)).toMatchObject({
        name: 'Background',
        outcome: 'completed',
        phaseCount: 1,
        tally: { total: 1, ok: 1, failed: 0, cancelled: 0 },
        errorCause: null,
      });
      expect(asked.opened.map((opened) => opened.payload.kind)).toEqual([]);
    }),
  );
});
