/**
 * Conformance over the golden 1.0 store
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md`
 * §11): `src/test-kernel/fixtures/storage/golden-1.0.sql`, which the real
 * CLI wrote (`pnpm --filter @texra-ai/cli run golden:store`). Every later
 * build must read it as this one does.
 *
 * The fixture holds only cleanly finished runs. Failure modes: a stored
 * row that no longer decodes; a fold that reads the same rows to a different
 * run or state; a projection that rebuilds to other rows than its
 * incremental tables hold; a listing that differs from the fold over the
 * whole history; a store a newer build wrote that opens, or is rewritten;
 * and the durable harness's row shapes read back other than written: a fork
 * whose `run.start` does not name its source, a fork or handoff
 * `context.edit` missing or out of order, an awaited child without the call
 * that owns it. Interrupted states are the crash-point suite's
 * (`crashConformance*.vitest.ts`), which truncates a clean store at every
 * commit and resumes it, but for one a real kill made: `golden_effect`,
 * killed (`SIGKILL`) after its command's effect landed and before its
 * result committed. A resume that runs that command again, or reports it
 * as anything but an unknown outcome, fails.
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
import { Effect, Layer, Stream, SubscriptionRef } from 'effect';
import { afterAll, afterEach, beforeEach, describe, expect } from 'vitest';

import { refresh } from '@agent/index';
import { resumeRun } from '@agent/runtime/resumeRun';
import { makeRunHistory } from '@agent/runtime/RunHistory';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import { databaseLayer } from '@controllers/session/Database';
import {
  EVENT_COLUMNS,
  EVENT_FROM,
  rowReader,
} from '@controllers/session/rowCodec';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { makeSessionStore } from '@controllers/session/sessionStore';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { withProcessServices } from '@platform/processRuntime';
import {
  aggregateId,
  isDisplaySessionEvent,
  ROW_KINDS,
  RunIdSchema,
  type RunId,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { FakeStateStore } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  closeTestDefaultSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import {
  fakeHostAgentDirectories,
  setupPlatform,
} from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

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
const PARENT = RunIdSchema.parse('a00000000001');
const CHAT = RunIdSchema.parse('a00000000008');
/** The chat's Codex child, detached by the user's stop. */
const CODEX = RunIdSchema.parse('a00000000009');
const SCRIPTED = RunIdSchema.parse('a0000000000a');
/** A headless run, the fork `texra resume --fork` made of it, and the
 *  handoff that continued the fork. */
const FORK_SOURCE = RunIdSchema.parse('a0000000000b');
const FORKED = RunIdSchema.parse('a0000000000c');
/** Killed after its command's effect, before the command's result. */
const KILLED = RunIdSchema.parse('a0000000000d');
const TOMBSTONED = RunIdSchema.parse('a0000000000e');
/** The service's task, and the background command it sent, whose input the
 *  service's resume closed. */
const SERVICE_TASK = RunIdSchema.parse('a0000000000f');
const BACKGROUND = RunIdSchema.parse('a00000000010');
/** The `texra run --output` document task and the revisions its recipe
 *  ran, named by the calls that launched them. */
const DOCUMENT_TASK = RunIdSchema.parse('a00000000005');
const REVISIONS = ['5fc0b51b6aa17245062995d1', '2690a561d6d483740d16c8e5'];

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
    status: run.status,
    outcome: run.durableOutcome,
    parent: run.parentId,
    children: run.childIds,
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
    return Effect.gen(function* () {
      const events = yield* rowReader(storage).read(rows, true);
      expect(events).toHaveLength(rows.length);
      const types = new Set(events.map((event) => event.type));
      // Every row kind is in the fixture, the decode test of a released store,
      // but `run.model`, projected at read time. The list only shrinks.
      const notStored = ['run.model'];
      expect(
        Object.keys(ROW_KINDS)
          .filter((kind) => !types.has(kind as (typeof events)[number]['type']))
          .toSorted(),
      ).toEqual(notStored);
      for (const type of [
        'tool.result',
        'request.decided',
        'followup.queued',
        'script.call',
        'context.edit',
        'run.removed',
      ] as const)
        expect(types, type).toContain(type);
      // The chat's `/model` switch: the configs naming the model before and
      // after it; and its `/compact`, the one edit.
      const chat = aggregateId('run', CHAT);
      expect(
        events.flatMap((event) =>
          event.type === 'context.edit' && event.aggregateId === chat
            ? [event.payload.trigger]
            : [],
        ),
      ).toEqual(['user']);
      expect([
        ...new Set(
          events.flatMap((event) =>
            event.type === 'run.config' && event.aggregateId === chat
              ? [event.config.model]
              : [],
          ),
        ),
      ]).toEqual(['openai/gpt-5.6-sol@medium', 'gemini38f']);
      // Each request is a queued control, consumed in the batch that applies
      // it: the switch's `run.config` (no edit), then the compaction's edit,
      // right after its consumption.
      const applied = raw(storage, (db) =>
        db
          .prepare(
            `SELECT json_extract(q.data, '$.control.kind') AS kind,
               (SELECT json_extract(x.data, '$.payload.trigger') FROM event c
                JOIN event x ON x.aggregate = c.aggregate AND x.seq = c.seq + 1
                  AND x.type = 'context.edit'
                WHERE c.type = 'followup.consumed' AND c.aggregate = q.aggregate
                  AND json_extract(c.data, '$.followUpId')
                    = json_extract(q.data, '$.followUpId')) AS trigger
             FROM event q JOIN event_sequence s ON s.id = q.aggregate
             WHERE s.logical_id = ? AND q.type = 'followup.queued'
               AND json_extract(q.data, '$.control') IS NOT NULL
             ORDER BY q."commit"`,
          )
          .all(CHAT),
      );
      expect(applied).toEqual([
        { kind: 'model', trigger: null },
        { kind: 'compact', trigger: 'user' },
      ]);
      // The durable harness's row shapes (H2): a fork's start names its
      // source, and its first history row seeds the source's view; a handoff
      // cuts the fork's view to its note; an awaited child names the call
      // that owns it, and a Codex child, which nobody awaits, names none.
      const forked = aggregateId('run', FORKED);
      expect(
        events.flatMap((event) =>
          event.type === 'run.start' && event.aggregateId === forked
            ? [event.provenance]
            : [],
        ),
      ).toEqual([
        {
          kind: 'fork',
          from: { id: FORK_SOURCE, uid: expect.any(String) },
          at: expect.any(Number),
        },
      ]);
      expect(
        events.flatMap((event) =>
          event.type === 'context.edit' && event.aggregateId === forked
            ? [[event.payload.cause, event.payload.messages.length > 0]]
            : [],
        ),
      ).toEqual([
        ['fork', true],
        ['handoff', false],
      ]);
      expect(
        events.flatMap((event) =>
          event.type === 'run.start' && event.parent !== null
            ? [[event.parent.id, event.parent.callId]]
            : [],
        ),
      ).toEqual([
        [PARENT, 'validation-agent-3'],
        // Each revision is an `agent` call in the recipe's script.
        [DOCUMENT_TASK, 'script/1'],
        [DOCUMENT_TASK, 'script/6'],
        [CHAT, null],
        [SERVICE_TASK, null],
      ]);
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
      const db = yield* Database;
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
      const done = { status: 'completed', outcome: 'completed' };
      const run = (
        id: string,
        label: string,
        rest: Readonly<Record<string, unknown>> = {},
      ) => ({
        id,
        label,
        ...done,
        parent: null,
        children: [],
        ...rest,
      });
      const DELEGATED = 'a00000000000000000000002';
      expect(runsOf(folded)).toEqual([
        run(PARENT, 'golden_parent', { children: [DELEGATED] }),
        run(DELEGATED, 'golden_child', { parent: PARENT }),
        run('a00000000003', 'review'),
        run('a00000000004', 'review'),
        // The document task and the two revisions its recipe ran.
        run(DOCUMENT_TASK, 'polish', { children: REVISIONS }),
        // Listed in start order, while the parent names them sorted.
        ...REVISIONS.toReversed().map((id) =>
          run(id, 'polish', { parent: DOCUMENT_TASK }),
        ),
        // The user stopped its held turn with Ctrl-C, which detached its
        // parked Codex child, then exited, which ended the child.
        run(CHAT, 'golden_chat', { status: 'cancelled', outcome: 'cancelled' }),
        run(CODEX, 'codex', { status: 'cancelled', outcome: 'cancelled' }),
        run(SCRIPTED, 'golden_script'),
        run(FORK_SOURCE, 'golden_fork'),
        // The resumed chat over the fork, exited at its idle prompt.
        run(FORKED, 'golden_fork', {
          status: 'cancelled',
          outcome: 'cancelled',
        }),
        // Killed while its command's result was uncommitted: it still reads
        // as running, its owner dead.
        run(KILLED, 'golden_effect', { status: 'running', outcome: null }),
        // Stopped with `texra tasks stop` once its command reported back.
        run(SERVICE_TASK, 'golden_script', {
          status: 'cancelled',
          outcome: 'cancelled',
          children: [BACKGROUND],
        }),
        run(BACKGROUND, 'bash', { parent: SERVICE_TASK }),
      ]);
      expect(folded.requests).toEqual([]);
      // The Codex turn's result and the message typed behind the stopped
      // turn stay queued for a resume to join. The headless parent holds
      // none: its child's message was refused, since a one-shot run never
      // reads one.
      expect(
        [...folded.queuedFollowUps].map(([id, queued]) => [id, queued.length]),
      ).toEqual([[CHAT, 2]]);
      const runHistory = makeRunHistory(
        (yield* makeSessionStore(storage)).log,
        yield* Database,
      );
      const stateOf = (id: RunId) =>
        Effect.map(runHistory.load(id), (state) => ({
          at: state?.at,
          phase: state?.phase,
          round: state?.round,
          modelId: state?.modelId,
          messages: state?.messages.map((message) => message.role),
          openAttempt: state?.invocation != null,
        }));
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
      expect((yield* runHistory.load(CHAT))?.modelId).toBe('gemini38f');
    }).pipe(
      Effect.provide(graph(storage)),
      Effect.provide(ProcessIdentity.layer(SELF)),
      Effect.scoped,
    );
  });

  it.effect(
    'refuses a store a newer build wrote to, and rewrites nothing',
    () => {
      // A newer build's `model.message` (one version past this build's),
      // committed as that build would: the row, its sequence, `stored_kind`.
      const storage = goldenRoot();
      raw(storage, (db) => {
        const { id, seq } = db
          .prepare('SELECT id, seq FROM event_sequence WHERE logical_id = ?')
          .get('a00000000004') as { id: number; seq: number };
        const version = ROW_KINDS['model.message'].version + 1;
        db.exec('BEGIN');
        db.prepare(
          `INSERT INTO event (aggregate, seq, type, version, origin, at, data)
         VALUES (?, ?, 'model.message', ?, '["newer-build",1,"later"]', 1767312000000, '{}')`,
        ).run(id, seq + 1, version);
        db.prepare('UPDATE event_sequence SET seq = ? WHERE id = ?').run(
          seq + 1,
          id,
        );
        db.prepare(
          `UPDATE stored_kind SET version = ? WHERE type = 'model.message'`,
        ).run(version);
        db.exec('COMMIT');
      });
      const stored = () =>
        raw(storage, (db) =>
          ['event', 'event_sequence', 'blob', 'event_blob', 'stored_kind'].map(
            (table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
          ),
        );
      const before = stored();
      return Effect.gen(function* () {
        expect(
          yield* Effect.flip(
            Effect.provide(
              Effect.gen(function* () {
                yield* Database;
              }),
              substrate(storage),
            ),
          ),
        ).toMatchObject({
          _tag: 'DatabaseOpenFailed',
          cause: { _tag: 'DatabaseStoreNewer', type: 'model.message' },
        });
        expect(stored()).toEqual(before);
      });
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
 * The real kill: `golden_effect`'s command appended its line, then the
 * process died before the command's result committed (the generator held it
 * in a `PostToolUse` hook). Its file is back on disk as the kill left it.
 * The resume must not run the command again: the call settles as an unknown
 * outcome, which the model reads, and the line stays one line.
 */
describe('the golden run killed after its effect', () => {
  const AGENTS = resolve(REPO_ROOT, 'src/test-kernel/fixtures/storage/agents');
  const EFFECT = resolve(
    REPO_ROOT,
    'src/test-kernel/fixtures/storage/golden-effect/approved.txt',
  );
  const tempDirs = useTempDirs();
  setupPlatform(async () => {
    const host = await createTempDirPlatform('texra-golden-kill-', tempDirs);
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
  beforeEach(async () => {
    const { storage, workspace } = testWorkspaceRoots();
    if (workspace === undefined) throw new Error('no test workspace');
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
    mkdirSync(workspace, { recursive: true });
    cpSync(EFFECT, join(workspace, 'approved.txt'));
    raw(storage, (db) => {
      db.prepare(
        `UPDATE event SET data = replace(data, '/golden/project', ?)
         WHERE type IN ('run.start', 'run.config') AND aggregate =
           (SELECT id FROM event_sequence WHERE logical_id = ?)`,
      ).run(workspace, KILLED);
      // The kill, on this host: an owner whose process is gone.
      db.prepare(
        'UPDATE event_sequence SET owner_id = ? WHERE logical_id = ?',
      ).run(
        JSON.stringify([os.hostname().toLowerCase(), process.pid, 'killed']),
        KILLED,
      );
    });
    writeFileSync(flag, 'texra-cli-run-validation\n');
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
    await Effect.runPromise(closeTestDefaultSession);
  });
  afterEach(async () => {
    await Effect.runPromise(closeTestDefaultSession);
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.live('reports the command as an unknown outcome and never reruns it', () =>
    Effect.gen(function* () {
      const { storage, workspace } = testWorkspaceRoots();
      const session = yield* openTestDefaultSession({
        roots: testWorkspaceRoots(),
      });
      const result = yield* withProcessServices(
        testRuntime(),
        resumeRun(KILLED, { session }),
      );
      expect(result).toMatchObject({ started: true });
      yield* closeTestDefaultSession;
      const settled = raw(storage, (db) =>
        db
          .prepare(
            `SELECT json_extract(e.data, '$.payload') AS payload
             FROM event e JOIN event_sequence s ON s.id = e.aggregate
             WHERE s.logical_id = ? AND e.type = 'tool.result'`,
          )
          .all(KILLED)
          .map((row) => JSON.parse(String(row.payload)) as unknown),
      );
      expect(settled).toHaveLength(1);
      expect(JSON.stringify(settled[0])).toContain('outcome is unknown');
      // The effect the killed process left, and nothing more.
      expect(
        readFileSync(join(workspace!, 'approved.txt'), 'utf8')
          .split('\n')
          .filter(Boolean),
      ).toEqual(['approved']);
    }),
  );
});
