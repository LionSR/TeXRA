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
 * rewritten.
 */
// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import {
  cpSync,
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
import { Effect, Layer, Stream, SubscriptionRef } from 'effect';
import { afterAll, afterEach, beforeEach, describe, expect } from 'vitest';

import { refresh } from '@agent/index';
import { resumeRun } from '@agent/runtime/resumeRun';
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
const CHAT = RunIdSchema.parse('a00000000009');
const TOMBSTONED = RunIdSchema.parse('a0000000000a');

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
      'workflow.script',
      'workflow.attempt',
      'workflow.journal',
      'run.removed',
    ] as const)
      expect(types, type).toContain(type);
    // The chat's `/model` switch: the compaction it records, and the
    // snapshots naming the model before and after it.
    const chat = aggregateId('run', CHAT);
    expect(
      events.filter(
        (event) =>
          event.type === 'model.compaction' &&
          event.aggregateId === chat &&
          event.payload.cause === 'model-switch',
      ),
    ).toHaveLength(1);
    expect([
      ...new Set(
        events.flatMap((event) =>
          event.type === 'run.snapshot' && event.aggregateId === chat
            ? [event.payload.runtime.modelId]
            : [],
        ),
      ),
    ]).toEqual(['gpt56', 'gemini38f']);
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
      const WORKFLOW = 'a00000000000000000000003';
      expect(runsOf(folded)).toEqual([
        // Its owner is on another host, so nothing proves it dead.
        run(PARKED, 'golden_park', { status: 'running', outcome: null }),
        run(PARENT, 'golden_parent', { children: ['a00000000006', WORKFLOW] }),
        run(WORKFLOW, 'golden-workflow', {
          category: 'workflow',
          parent: PARENT,
          children: ['a00000000000000000000005'],
        }),
        run('a00000000000000000000005', 'golden_child', { parent: WORKFLOW }),
        run('a00000000006', 'golden_child', { parent: PARENT }),
        run('a00000000007', 'review'),
        run('a00000000008', 'review'),
        // The user stopped its held turn with Ctrl-C, then exited.
        run(CHAT, 'golden_chat', { status: 'cancelled', outcome: 'cancelled' }),
      ]);
      expect(folded.requests).toEqual([]);
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
        modelId: 'gpt56',
        messages: ['user'],
        openAttempt: true,
      });
      expect(yield* stateOf(PARENT)).toEqual({
        at: 'halted',
        phase: 'waiting',
        round: 5,
        modelId: 'gpt56',
        messages: [
          'user',
          ...['assistant', 'tool', 'assistant', 'tool'],
          ...['assistant', 'tool', 'assistant', 'tool'],
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
      const NEWER = RunIdSchema.parse('a00000000007');
      const UNKNOWN = RunIdSchema.parse('a00000000008');
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
          ...Array.from({ length: 4 }, () => 'completed'),
          'cancelled',
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
 * The parked run resumed by this build, on the scripted model that wrote it
 * (`goldenTurn`, gated as the package validation gates it): the request the
 * resume sends must be the one its rows recorded, down to the address of
 * its recorded context. Under Vitest the invoker also checks, before the
 * request leaves, that the rows rebuild the prepared turn exactly.
 */
describe('the parked golden run', () => {
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
    // The crash, on this host: an owner whose process identity is gone.
    raw(storage, (db) =>
      db
        .prepare('UPDATE event_sequence SET owner_id = ? WHERE logical_id = ?')
        .run(
          JSON.stringify([os.hostname().toLowerCase(), process.pid, 'killed']),
          PARKED,
        ),
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
});
