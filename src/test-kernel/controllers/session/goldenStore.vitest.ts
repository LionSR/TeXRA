/**
 * Conformance over the golden 1.0 store:
 * `src/test-kernel/fixtures/storage/golden-1.0.sql`, which the real
 * CLI wrote (`pnpm --filter @texra-ai/cli run golden:store`). Every later
 * build must read it as this one does.
 *
 * The fixture holds only cleanly finished runs. Failure modes: a stored
 * row that no longer decodes; a fold that reads the same rows to a different
 * run or state; a store a newer build wrote that opens, or is rewritten;
 * a resume of a run holding an earlier build's row that fails untyped,
 * sends the model a request, or adds a row; and the durable harness's row
 * shapes read back
 * other than written: a fork
 * whose `run.start` does not name its source, a fork's seed
 * `context.edit` missing, an awaited child without the call
 * that owns it. Interrupted states are the crash-point suite's
 * (`crashConformance*.vitest.ts`), which truncates a clean store at every
 * commit and resumes it, but for one a real kill made: `golden_effect`,
 * killed (`SIGKILL`) after its command's effect landed and before its
 * result committed. A resume that runs that command again, or reports it
 * as anything but an unknown outcome, fails.
 */
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
import { it, layer } from '@effect/vitest';
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  Schema,
  Stream,
  SubscriptionRef,
  Context,
} from 'effect';
import { afterAll, describe, expect, vi } from 'vitest';

import {
  qualifyAggregateId,
  type RunId,
  RunIdSchema,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { ResumeRefused, Sessions } from '@texra-ai/harness';
import { AgentCatalog, ValidationModel } from '@texra-ai/harness/host';
import { resumeRun } from '@agent/runtime/resumeRun';
import { makeRunHistory } from '@agent/runtime/RunHistory';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import { validationModelLayer } from '@cli/runtime/validationModel';
import { databaseLayer } from '@controllers/session/Database';
import { EVENT_COLUMNS, EVENT_FROM } from '@controllers/session/rowCodec';
import { rowReader } from '@controllers/session/rowReader';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { makeSessionStore } from '@controllers/session/sessionStore';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { ROW_KINDS } from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { SessionViewAccess } from '@shared/session/runHistory';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import { storePluginsLayer } from '@test/support/texraApp';
import {
  persistentTestSession,
  readStoreSnapshot,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { TEXRA_APP, texraHosted } from '@test/support/texraApp';
import { texraPlugins } from '@texra/tools/registry';
import { factKindsOf } from '@tools/plugins';
import type { Model } from '@texra-ai/llm';

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
const PARENT = Schema.decodeUnknownSync(RunIdSchema)('a00000000001');
const CHAT = Schema.decodeUnknownSync(RunIdSchema)('a00000000008');
/** The goal script the chat's plan launched, named by the plan call, and
 *  its one round, named by the script's `self()` call. */
const GOAL = Schema.decodeUnknownSync(RunIdSchema)('a286c3e6ac6ffc44325e54fe');
const ROUND = '2b49f9193d96636ca02a91b4';
/** The chat's Codex child, detached by the user's stop. */
const CODEX = Schema.decodeUnknownSync(RunIdSchema)('a0000000000b');
const SCRIPTED = Schema.decodeUnknownSync(RunIdSchema)('a0000000000c');
/** The agent the script defined (`persona`), named by its `agent()` call. */
const DEFINED = '6d8096657d434c473cddf020';
/** A headless run, and the fork `texra resume --fork` made of it. */
const FORK_SOURCE = Schema.decodeUnknownSync(RunIdSchema)('a0000000000e');
const FORKED = Schema.decodeUnknownSync(RunIdSchema)('a0000000000f');
/** Killed after its command's effect, before the command's result. */
const KILLED = Schema.decodeUnknownSync(RunIdSchema)('a00000000010');
/** The service's task; the background command it sent, whose input the
 *  service's resume closed, is a finished shell the deletion's open swept
 *  (its rows stay, under its deletion marker, for the next open to collect). */
const SERVICE_TASK = Schema.decodeUnknownSync(RunIdSchema)('a00000000012');
/** The `texra run --output` document task and the revisions its recipe
 *  ran, named by the calls that launched them. */
const DOCUMENT_TASK = Schema.decodeUnknownSync(RunIdSchema)('a00000000005');
const REVISIONS = ['c7f87768952686e0f3507090', '07786de16152981e0bb228d2'];

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
    Layer.provide(storePluginsLayer),
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

describe('the golden 1.0 store', () => {
  it.effect(
    'decodes every row to an event, and holds every row kind, a fork, owned children and shared blobs',
    () => {
      const storage = goldenRoot();
      const rows = raw(storage, (db) =>
        db
          .prepare(
            `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM} ORDER BY e."commit"`,
          )
          .all(),
      );
      return Effect.gen(function* () {
        // The fixture's own connection runs the reader's earlier-build scan.
        const exec = (statement: string, params: readonly unknown[]) =>
          Effect.sync(() =>
            raw(storage, (db) =>
              db
                .prepare(statement)
                .all(
                  ...Schema.decodeUnknownSync(
                    Schema.Array(Schema.Union([Schema.String, Schema.Number])),
                  )(params),
                ),
            ),
          );
        const events = yield* rowReader(
          storage,
          factKindsOf(texraPlugins({ name: 'vscode' })),
          exec,
        ).read(rows, true);
        expect(events).toHaveLength(rows.length);
        const types = new Set<string>(events.map((event) => event.type));
        // Every row kind is in the fixture, the decode test of a released store.
        expect(
          Object.keys(ROW_KINDS)
            .filter((kind) => !types.has(kind))
            .toSorted(),
        ).toEqual([]);
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
        const chat = qualifyAggregateId('run', CHAT);
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
        ]).toEqual(['openai/gpt-5.6-sol', 'google/gemini-3.8-flash@medium']);
        // Each request is a queued control, consumed in the batch that applies
        // it, and its consumption says so: the switch's (`run.config`) and
        // the compaction's (its edit).
        const applied = raw(storage, (db) =>
          db
            .prepare(
              `SELECT json_extract(q.data, '$.control.kind') AS kind,
               (SELECT json_extract(c.data, '$.disposition.kind') FROM event c
                WHERE c.type = 'followup.consumed' AND c.aggregate = q.aggregate
                  AND json_extract(c.data, '$.followUpId')
                    = json_extract(q.data, '$.followUpId')) AS disposition
             FROM event q JOIN event_sequence s ON s.id = q.aggregate
             WHERE s.logical_id = ? AND q.type = 'followup.queued'
               AND json_extract(q.data, '$.control') IS NOT NULL
             ORDER BY q."commit"`,
            )
            .all(CHAT),
        );
        expect(applied).toEqual([
          { kind: 'model', disposition: 'applied' },
          { kind: 'compact', disposition: 'applied' },
        ]);
        // The durable harness's row shapes: a fork's start names its
        // source, and its first history row seeds the source's view; an
        // awaited child names the call
        // that owns it, and a Codex child, which nobody awaits, names none.
        const forked = qualifyAggregateId('run', FORKED);
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
        ).toEqual([['fork', true]]);
        expect(
          events.flatMap((event) =>
            event.type === 'run.start' && event.parent !== null
              ? [[event.parent.id, event.parent.call?.callId ?? null]]
              : [],
          ),
        ).toEqual([
          [PARENT, 'validation-agent-3'],
          // Each revision is an `agent` call in the recipe's script.
          [DOCUMENT_TASK, 'script/1'],
          [DOCUMENT_TASK, 'script/6'],
          // The goal is the plan call's child; its round, its program's.
          [CHAT, 'validation-plan-1'],
          [GOAL, 'script/0'],
          [CHAT, null],
          // The agent the script defined is its `agent()` call's child.
          [SCRIPTED, 'validation-script-1/4'],
          [SERVICE_TASK, null],
        ]);
        // It asked for `executions`, and a child is offered what it declares,
        // whatever its parent was offered.
        const defined = qualifyAggregateId(
          'run',
          Schema.decodeUnknownSync(RunIdSchema)(DEFINED),
        );
        expect(
          events.flatMap((event) =>
            event.type === 'tools.offered' && event.aggregateId === defined
              ? [event.payload.tools.map(({ name }) => name)]
              : [],
          ),
        ).toEqual([['read_file', 'executions', 'memory', 'plan']]);
        // The plan the chat ran as a goal: a run on the default strategy, its
        // agent the chat's, that ends with the goal's result: what its one
        // round verified, and what that round spent.
        const goal = qualifyAggregateId('run', GOAL);
        expect(
          events.flatMap((event) =>
            event.type === 'run.end' && event.aggregateId === goal
              ? [event.output.structured]
              : [],
          ),
        ).toEqual([
          {
            outcome: 'completed',
            rounds: 1,
            spent: 0.000048,
            report: 'The golden chat is answered.',
          },
        ]);
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
      });
    },
  );

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
        run(CHAT, 'golden_chat', {
          status: 'cancelled',
          outcome: 'cancelled',
          children: [GOAL],
        }),
        run(GOAL, 'Goal', { parent: CHAT, children: [ROUND] }),
        run(ROUND, 'golden_chat', { parent: GOAL }),
        run(CODEX, 'codex', { status: 'cancelled', outcome: 'cancelled' }),
        run(SCRIPTED, 'golden_script', { children: [DEFINED] }),
        run(DEFINED, 'golden_reader', { parent: SCRIPTED }),
        run(FORK_SOURCE, 'golden_fork'),
        // The resumed chat over the fork, exited at its idle prompt.
        run(FORKED, 'golden_fork', {
          status: 'cancelled',
          outcome: 'cancelled',
        }),
        // Killed while its command's result was uncommitted: it still reads
        // as running, its owner dead.
        run(KILLED, 'golden_effect', { status: 'running', outcome: null }),
        // Stopped with `texra tasks stop` once its command reported back;
        // the command itself was swept with the deletion's open.
        run(SERVICE_TASK, 'golden_script', {
          status: 'cancelled',
          outcome: 'cancelled',
        }),
      ]);
      expect(folded.requests).toEqual([]);
      // The Codex turn's result and the message typed behind the stopped
      // turn stay queued for a resume to join. The headless parent holds
      // none: its child's message was refused, since a one-shot run never
      // reads one.
      expect(
        [...folded.queuedFollowUps].map(([id, queued]) => [id, queued.length]),
      ).toEqual([[CHAT, 2]]);
      const runHistory = makeRunHistory((yield* makeSessionStore(storage)).log);
      const stateOf = (id: RunId) =>
        Effect.map(runHistory.load(id), (state) => ({
          at: state?.at,
          phase: state?.phase,
          modelId: state?.modelId,
          messages: state?.messages.map((message) => message.role),
          openAttempt: state?.invocation != null,
        }));
      // The stop kept where the loop stood: a halt records only the outcome.
      expect(yield* stateOf(PARENT)).toEqual({
        at: 'waiting',
        phase: 'waiting',
        modelId: 'openai/gpt-5.6-sol',
        messages: [
          'user',
          ...['assistant', 'tool', 'assistant', 'tool'],
          ...['assistant', 'tool'],
          'assistant',
        ],
        openAttempt: false,
      });
      expect((yield* runHistory.load(CHAT))?.modelId).toBe(
        'google/gemini-3.8-flash@medium',
      );
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
        const { id, seq } = Schema.decodeUnknownSync(
          Schema.Struct({ id: Schema.Number, seq: Schema.Number }),
        )(
          db
            .prepare('SELECT id, seq FROM event_sequence WHERE logical_id = ?')
            .get('a00000000004'),
        );
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
  const VALIDATION = {
    TEXRA_INTERNAL_VALIDATE_MODEL: '1',
    TEXRA_INTERNAL_VALIDATE_GOLDEN: '1',
  };
  /** The test's host as the kill left it: the golden store and the effect on
   *  a temp-dir host whose agents are the fixtures', loaded into the block's
   *  catalog, with the validation model answering. The release puts the
   *  environment back. */
  const killedHost = Layer.effectDiscard(
    Effect.gen(function* () {
      const { storage, workspace } = (yield* FakeHost).roots;
      if (workspace === undefined) throw new Error('no test workspace');
      const flag = join(storage, 'validation-flag');
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          for (const [name, value] of Object.entries({
            ...VALIDATION,
            TEXRA_INTERNAL_VALIDATE_MODEL_FLAG: flag,
          }))
            vi.stubEnv(name, value);
        }),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      cpSync(goldenRoot(), storage, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      cpSync(EFFECT, join(workspace, 'approved.txt'));
      raw(storage, (db) => {
        // The path lands inside a JSON string, so it goes in escaped as one:
        // a Windows path's backslashes would otherwise corrupt the row.
        db.prepare(
          `UPDATE event SET data = replace(data, '/golden/project', ?)
         WHERE type IN ('run.start', 'run.config') AND aggregate =
           (SELECT id FROM event_sequence WHERE logical_id = ?)`,
        ).run(JSON.stringify(workspace).slice(1, -1), KILLED);
      });
      writeFileSync(flag, 'texra-cli-run-validation\n');
      yield* AgentCatalog.use((catalog) => catalog.refresh).pipe(Effect.orDie);
    }),
  ).pipe(
    Layer.provideMerge(
      FakeHost.layer(async () => {
        const host = await createTempDirPlatform(
          'texra-golden-kill-',
          tempDirs,
          TEXRA_APP,
        );
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
      }),
    ),
  );

  layer(texraHosted, { excludeTestServices: true })((it) => {
    it.layer(killedHost, { buildPerTest: true })((it) => {
      it.effect(
        'reports the command as an unknown outcome and never reruns it',
        () =>
          Effect.gen(function* () {
            const { storage, workspace } = testWorkspaceRoots();
            if (workspace === undefined) throw new Error('no test workspace');
            // The resume, in a session that closes before the store is read.
            yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* persistentTestSession();
                const result = yield* resumeRun(KILLED, {}).pipe(
                  Effect.provide(session),
                );
                if (!('activation' in result))
                  throw new Error('resume refused');
                // The resumed activation rests, or ends.
                yield* Stream.runHead(
                  Stream.filter(
                    Context.get(session, SessionViewAccess).changes,
                    (view) => {
                      const run = view.runs.get(KILLED);
                      return (
                        view.cursor > result.activation &&
                        (run?.status === 'waiting' ||
                          run?.durableOutcome != null)
                      );
                    },
                  ),
                );
              }),
            );
            const settled = raw(storage, (db) =>
              db
                .prepare(
                  `SELECT json_extract(e.data, '$.payload') AS payload
             FROM event e JOIN event_sequence s ON s.id = e.aggregate
             WHERE s.logical_id = ? AND e.type = 'tool.result'`,
                )
                .all(KILLED)
                .map((row): unknown => JSON.parse(String(row.payload))),
            );
            expect(settled).toHaveLength(1);
            expect(JSON.stringify(settled[0])).toContain('outcome is unknown');
            // The effect the killed process left, and nothing more.
            expect(
              readFileSync(join(workspace, 'approved.txt'), 'utf8')
                .split(/\r?\n/)
                .filter(Boolean),
            ).toEqual(['approved']);
          }),
      );
    });
  });
});

/**
 * R11 of the harness 1.0 release acceptance: a resume of a golden run whose
 * rows this build cannot continue is refused, with its reason, before the
 * model's transport is sent anything, and the store gains no row. The
 * golden chat holds input queued behind its stopped turn, so a resume that
 * went ahead sends a turn at once, as it does over the unchanged store.
 */
describe("the golden chat's resume", { timeout: REAL_RUN_TIMEOUT }, () => {
  /** The validation model, counting the turns sent to it; `first` opens
   *  with the first. */
  const countedModel = () => {
    const sent = { turns: 0, first: Deferred.makeUnsafe<void>() };
    const model = Layer.effect(
      ValidationModel,
      Effect.map(ValidationModel, (inner) => ({
        enabled: inner.enabled,
        bind: (config: Parameters<typeof inner.bind>[0]) => {
          const bound = inner.bind(config);
          return {
            ...bound,
            model: {
              ...bound.model,
              streamTurn: (turn: Parameters<Model['streamTurn']>[0]) => {
                sent.turns += 1;
                Deferred.doneUnsafe(sent.first, Exit.void);
                return bound.model.streamTurn(turn);
              },
            },
          };
        },
      })),
    ).pipe(Layer.provide(validationModelLayer));
    return { sent, process: SessionGraph.with([], model) };
  };
  /** The chat's last model response. */
  const RESPONSE = 596;
  /** The golden store, with `rewrite` applied, and a session over it. */
  const goldenSession = (rewrite?: string) =>
    Effect.gen(function* () {
      const storage = goldenRoot();
      if (rewrite !== undefined) raw(storage, (db) => db.exec(rewrite));
      const session = yield* (yield* Sessions).open(
        { ...testWorkspaceRoots(), storage },
        { persistent: true, host: {} },
      );
      return { storage, session };
    });
  /** The chat's stored rows. */
  const chatRows = (storage: string) =>
    readStoreSnapshot(storage, (db) =>
      db
        .prepare(
          `SELECT e.* FROM event e JOIN event_sequence s ON s.id = e.aggregate
           WHERE s.logical_id = ? ORDER BY e."commit"`,
        )
        .all(CHAT),
    );

  layer(texraHosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-golden-resume-', TEXRA_APP), {
      buildPerTest: true,
    })((it) => {
      it.effect.each([
        [
          "an earlier build's row",
          `UPDATE event SET version = 1 WHERE "commit" = ${RESPONSE}`,
          { kind: 'earlierBuild', cause: expect.any(String) },
        ],
        [
          'a row that does not decode',
          `UPDATE event SET data = '{}' WHERE "commit" = ${RESPONSE}`,
          { kind: 'unusableCheckpoint' },
        ],
      ] as const)(
        'refuses a run holding %s before any request, and adds no row',
        ([, rewrite, reason]) => {
          const { sent, process } = countedModel();
          return Effect.gen(function* () {
            const { storage, session } = yield* goldenSession(rewrite);
            const before = chatRows(storage);
            const refused = yield* Effect.flip(
              session.resume(CHAT, { interactive: true }),
            );
            expect(refused).toBeInstanceOf(ResumeRefused);
            expect(refused).toMatchObject({ runId: CHAT, reason });
            expect(sent.turns).toBe(0);
            expect(chatRows(storage)).toEqual(before);
          }).pipe(Effect.scoped, Effect.provide(process, { local: true }));
        },
      );

      it.effect('resumes the unchanged chat, which sends a turn', () => {
        const { sent, process } = countedModel();
        return Effect.gen(function* () {
          const { session } = yield* goldenSession();
          const run = yield* session.resume(CHAT, { interactive: true });
          expect(run.runId).toBe(CHAT);
          yield* Deferred.await(sent.first);
        }).pipe(
          Effect.timeout('20 seconds'),
          Effect.scoped,
          Effect.provide(process, { local: true }),
        );
      });
    });
  });
});
