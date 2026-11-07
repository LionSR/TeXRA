/**
 * Faults injected into the real store, never a mocked one: the run engine's
 * suites drive real sessions over a real SQLite file and the validation
 * model, and fail, hold or crash that store where a case needs a race. Each
 * takes what it runs on from the calling block (`SessionGraph`): the
 * sessions, the store handles and the agent catalog are the block's.
 *
 * - {@link sessionStoreFaults} arms faults on the `Database` the block's
 *   process holds for a persistent session's root, the instance its
 *   sessions borrow from `ProjectDatabases` (which has no other test seam):
 *   the next call of a named operation fails as the store fails
 *   (`DatabaseWriteFailed` or `DatabaseReadFailed`, nothing written), or
 *   waits, before it starts, until the case releases or fails it.
 *   `appendAll` may be narrowed to a batch holding one row type; a held
 *   `appendAll` or `job` holds the session's one publisher, as a slow commit
 *   does. Every operation runs the real store's code unless a fault is
 *   armed, and the faults go with the caller's scope.
 * - {@link parkedRunAfterCrash} is a process killed with a run parked: the
 *   committed store copied to a fresh root, and a fresh session opened
 *   over it.
 * - {@link validationHost} is the host those sessions run on, one per test:
 *   a temp-dir platform whose model is the validation model
 *   (`TEXRA_INTERNAL_VALIDATE_*`): a golden fixture agent plays its script,
 *   any other agent answers with what it was sent.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  type Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  RcMap,
  Ref,
  Schema,
  type Scope,
} from 'effect';
import { vi } from 'vitest';

import { API_KEY_ENV_NAMES, apiKeySecretName } from '@texra-ai/llm';
import { AgentCatalog, type HostInteractions } from '@texra-ai/harness/host';
import {
  attachInteractions,
  Interactions,
} from '@agent/runtime/HostInteractions';
import {
  rootRun,
  type SessionOwner,
  type SessionServices,
} from '@agent/runtime/rootLaunch';
import {
  VALIDATION_FLAG,
  VALIDATION_FLAG_CONTENT,
  VALIDATION_SCENARIOS,
  VALIDATION_SWITCH,
} from '@cli/runtime/models/validationSwitch';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  AgentConfigSchema,
  type RunId,
  type SessionRowDraft,
} from '@shared/schemas';
import {
  DatabaseReadFailed,
  DatabaseWriteFailed,
  ProjectDatabases,
  type DatabaseOpenFailed,
  type SessionOpenError,
} from '@shared/session/database';

import { generateRunId } from '@shared/schemas';
import type { TestApp } from './FakePlatform';
import { REPO_ROOT } from './repoScan';
import { createTempDirPlatform } from './tempDirPlatform';
import { FakeHost, sessionHandleOf, TestSession } from './testKernel';
import { testWorkspaceRoots } from './testWorkspaceRoots';
import type { Sessions } from '@texra-ai/harness';

const WRITES = ['appendAll', 'job'] as const;
const READS = [
  'readRunRecords',
  'readAggregate',
  'readInputBatch',
  'aggregateState',
] as const;
/** The store operations a fault can be armed on. */
type StoreOperation = (typeof WRITES)[number] | (typeof READS)[number];

/** A held operation: `reached` once a call is waiting; `release` lets it
 *  run, `fail` fails it as `failNext` would. */
interface StoreHold {
  readonly reached: Effect.Effect<void>;
  readonly release: Effect.Effect<void>;
  readonly fail: Effect.Effect<void>;
}

interface Armed {
  readonly operation: StoreOperation;
  readonly rowType: SessionRowDraft['type'] | undefined;
  readonly fault:
    | { readonly kind: 'fail' }
    | {
        readonly kind: 'hold';
        readonly reached: Deferred.Deferred<void>;
        /** True to run the call, false to fail it. */
        readonly released: Deferred.Deferred<boolean>;
      };
}

/** The faults a case arms on one store. */
interface StoreFaults {
  /** The next matching call fails as the store would: rolled back, nothing
   *  written. `rowType` narrows `appendAll` to a batch holding that row and
   *  is named in the error (`injected appendAll fault (run.end)`). */
  readonly failNext: (
    operation: StoreOperation,
    rowType?: SessionRowDraft['type'],
  ) => Effect.Effect<void>;
  /** The next matching call waits, before it starts, until the hold is
   *  released or failed; the faults' scope releases any hold left. */
  readonly holdNext: (
    operation: StoreOperation,
    rowType?: SessionRowDraft['type'],
  ) => Effect.Effect<StoreHold>;
}

/**
 * {@link StoreFaults} on the `Database` the calling block's process holds
 * for the persistent session root `storage`: the instance the sessions
 * opened there borrow, so their readers and their publisher see the
 * faults. The store is borrowed, and its operations wrapped, for the
 * caller's scope.
 */
export const sessionStoreFaults = (
  storage: string,
): Effect.Effect<
  StoreFaults,
  DatabaseOpenFailed,
  ProjectDatabases | Scope.Scope
> =>
  Effect.gen(function* () {
    const database = yield* RcMap.get(yield* ProjectDatabases, storage);
    const armed = yield* Ref.make<readonly Armed[]>([]);
    const matches = (entry: Armed, operation: string, args: unknown[]) =>
      entry.operation === operation &&
      (entry.rowType === undefined ||
        operation !== 'appendAll' ||
        // cast: appendAll's first argument is the batch of drafts it commits.
        (args[0] as readonly SessionRowDraft[]).some(
          (draft) => draft.type === entry.rowType,
        ));
    /** The first fault matching this call, disarmed as it is taken. */
    const take = (operation: string, args: unknown[]) =>
      Ref.modify(armed, (entries) => {
        const index = entries.findIndex((entry) =>
          matches(entry, operation, args),
        );
        return index < 0
          ? [undefined, entries]
          : [entries[index], entries.toSpliced(index, 1)];
      });
    // The message names the row type a fault was narrowed to, so a case
    // with two faults can tell which one an error carries.
    const failure = ({ operation, rowType }: Armed) => {
      const cause = new Error(
        `injected ${operation} fault${rowType ? ` (${rowType})` : ''}`,
      );
      return WRITES.some((write) => write === operation)
        ? new DatabaseWriteFailed({ path: storage, cause })
        : new DatabaseReadFailed({ path: storage, cause });
    };
    // The wrapper forwards each operation's arguments and result untouched.
    type Operation = (...args: unknown[]) => Effect.Effect<unknown, unknown>;
    const originals = Object.fromEntries(
      [...WRITES, ...READS].map((operation) => [
        operation,
        // cast: each named operation is a function returning an Effect.
        database[operation] as Operation,
      ]),
    );
    const faulty = Object.fromEntries(
      Object.entries(originals).map(([operation, original]) => [
        operation,
        (...args: unknown[]) =>
          Effect.flatMap(take(operation, args), (entry) => {
            if (entry === undefined) return original(...args);
            if (entry.fault.kind === 'fail') return Effect.fail(failure(entry));
            return Deferred.succeed(entry.fault.reached, undefined).pipe(
              Effect.andThen(Deferred.await(entry.fault.released)),
              Effect.flatMap((run) =>
                run ? original(...args) : Effect.fail(failure(entry)),
              ),
            );
          }),
      ]),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => Object.assign(database, faulty)),
      () => Effect.sync(() => Object.assign(database, originals)),
    );
    // A case that fails while a call is held leaves the publisher parked:
    // the scope lets every hold run, so closing the session never hangs.
    const holds = yield* Ref.make<readonly Deferred.Deferred<boolean>[]>([]);
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(holds), (released) =>
        Effect.forEach(released, (hold) => Deferred.succeed(hold, true), {
          discard: true,
        }),
      ),
    );
    const arm = (entry: Armed) =>
      Ref.update(armed, (entries) => [...entries, entry]);
    return {
      failNext: (operation, rowType) =>
        arm({ operation, rowType, fault: { kind: 'fail' } }),
      holdNext: (operation, rowType) =>
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>();
          const released = yield* Deferred.make<boolean>();
          yield* Ref.update(holds, (all) => [...all, released]);
          yield* arm({
            operation,
            rowType,
            fault: { kind: 'hold', reached, released },
          });
          return {
            reached: Deferred.await(reached),
            release: Effect.asVoid(Deferred.succeed(released, true)),
            fail: Effect.asVoid(Deferred.succeed(released, false)),
          };
        }),
    };
  });

/** The store's file in a session root. */
const storeFile = (storage: string) => join(storage, 'texra.db');

/**
 * Rebuild a copy of the clean store as a process killed after commit `n`
 * left it: every durable table at the cut,
 * not the later store with rows cut away. Rows, their blobs and sequences
 * go back to commit `n`; a plugin aggregate hangs where its last fact at
 * the cut put it; current values and input history written after the cut's
 * clock go (one the later run overwrote in place reads as never written).
 * `stored_kind` is append-only and kept: every version in it is this
 * build's, so the gate reads it as it would at the cut.
 * The projections rebuild from the rows on open.
 */
export function crashAt(clean: string, storage: string, n: number): void {
  mkdirSync(storage, { recursive: true });
  cpSync(clean, storeFile(storage));
  const db = new DatabaseSync(storeFile(storage));
  try {
    const at = db
      .prepare(
        'SELECT at FROM event WHERE "commit" <= ? ORDER BY "commit" DESC LIMIT 1',
      )
      .get(n)?.at;
    db.exec(`
      DELETE FROM projection_state; DELETE FROM projected_row;
      DELETE FROM listing_entry; DELETE FROM run_usage;
      DELETE FROM event_blob WHERE "commit" > ${n};
      DELETE FROM event WHERE "commit" > ${n};
      DELETE FROM event_sequence WHERE id NOT IN (SELECT aggregate FROM event);
      DELETE FROM blob WHERE digest NOT IN (SELECT digest FROM event_blob);
      UPDATE event_sequence SET
        seq = (SELECT max(seq) FROM event WHERE aggregate = event_sequence.id),
        closed_by = CASE WHEN closed_by > ${n} THEN NULL ELSE closed_by END;
      UPDATE event_sequence SET parent_id = (
        SELECT p.id FROM event e JOIN event_sequence p
          ON p.kind = 'run' AND p.logical_id = json_extract(e.data, '$.parent')
        WHERE e.aggregate = event_sequence.id AND e.type = 'plugin.fact'
        ORDER BY e.seq DESC LIMIT 1)
      WHERE kind <> 'run';
      DELETE FROM current_value WHERE at > ${Number(at ?? 0)};
      DELETE FROM input_history WHERE at > ${Number(at ?? 0)};
      UPDATE sqlite_sequence SET seq = ${n} WHERE name = 'event';
    `);
  } finally {
    db.close();
  }
}

/**
 * Read the store at `storage` as another process sees it: a session holds
 * its store exclusively, so a copy of the file and its WAL is opened, read
 * by `read`, and removed.
 */
export const readStoreSnapshot = <A>(
  storage: string,
  read: (db: DatabaseSync) => A,
): A => {
  const dir = mkdtempSync(join(tmpdir(), 'texra-store-snapshot-'));
  try {
    const copy = join(dir, 'texra.db');
    cpSync(storeFile(storage), copy);
    const wal = `${storeFile(storage)}-wal`;
    if (existsSync(wal)) cpSync(wal, `${copy}-wal`);
    const db = new DatabaseSync(copy);
    try {
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * A process killed now: what the store at `storage` has committed, and the
 * run files beside it, copied to a fresh root. Returns that root, for a
 * fresh session to open.
 */
export function crashedCopy(storage: string): string {
  const crashed = join(storage, `crashed-${Date.now()}`);
  const committed = join(storage, 'committed.db');
  const commit = readStoreSnapshot(storage, (db) => {
    const seq = Number(
      db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'event'").get()
        ?.seq ?? 0,
    );
    db.exec(`VACUUM INTO '${committed}'`);
    return seq;
  });
  crashAt(committed, crashed, commit);
  if (existsSync(join(storage, 'executions')))
    cpSync(join(storage, 'executions'), join(crashed, 'executions'), {
      recursive: true,
    });
  return crashed;
}

const StoredRowsSchema = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      commit: Schema.Number,
      run: Schema.String,
      parent: Schema.NullOr(Schema.String),
      type: Schema.String,
      data: Schema.String,
    }),
  ),
);
/** One stored run row, read straight from the file. */
export type StoredRow = (typeof StoredRowsSchema.Type)[number];

/** Every run row the store at `storage` holds, in commit order. */
export const storedRows = (storage: string): StoredRow[] =>
  readStoreSnapshot(storage, (db) => {
    const rows = db
      .prepare(
        `SELECT e."commit" AS "commit", s.logical_id AS run,
           (SELECT json_extract(f.data, '$.parent.id') FROM event f
            WHERE f.aggregate = s.id AND f.type = 'run.start') AS parent,
           e.type AS type, e.data AS data
         FROM event e JOIN event_sequence s ON s.id = e.aggregate
         WHERE s.kind = 'run' ORDER BY e."commit"`,
      )
      .all();
    return Schema.decodeUnknownSync(StoredRowsSchema)(rows);
  });

/** A suite's timeout for real runs on a contended machine: the kernel's
 *  10 seconds is too tight. */
export const REAL_RUN_TIMEOUT = 30_000;

const AGENTS = resolve(REPO_ROOT, 'src/test-kernel/fixtures/storage/agents');
/** The personas the extension ships, the built-in agents of a real host. */
export const BUNDLED_AGENTS = resolve(
  REPO_ROOT,
  'packages/extension/resources/agents',
);
const VALIDATION = {
  [VALIDATION_SWITCH]: '1',
  [VALIDATION_SCENARIOS.golden]: '1',
  [VALIDATION_SCENARIOS.echo]: '1',
};

/**
 * The host a test runs on, as a layer built per test (`buildPerTest: true`)
 * inside a `SessionGraph` block, whose agent catalog it loads: a temp-dir
 * host whose agents are the golden fixtures and the bundled personas and
 * whose model is the validation model, running `app` (the harness's
 * unless named), where a golden agent plays its
 * script and any other answers with what it was sent. No provider key comes
 * from the shell: its keys are the ones its secrets store. The release puts
 * the environment back and removes the temp dir.
 */
export const validationHost = (
  prefix: string,
  app?: TestApp,
): Layer.Layer<FakeHost, never, AgentCatalog> =>
  Layer.effect(
    FakeHost,
    Effect.gen(function* () {
      // Removed last, once the sessions on it closed with the test.
      const tempDirs: string[] = [];
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const dir of tempDirs)
            rmSync(dir, { recursive: true, force: true });
        }),
      );
      const host = Context.get(
        yield* Layer.build(
          FakeHost.layer(async () => {
            const host = await createTempDirPlatform(prefix, tempDirs, app);
            const agents = {
              custom: () => Effect.succeed(AGENTS),
              customConfigured: () => Effect.succeed(false),
              builtIn: () => Effect.succeed(BUNDLED_AGENTS),
            };
            return {
              ...host,
              platform: { ...host.platform, agentDirectories: agents },
            };
          }),
        ),
        FakeHost,
      );
      const { storage, workspace } = host.roots;
      const flag = join(storage, 'validation-flag');
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          for (const [name, value] of Object.entries({
            ...VALIDATION,
            [VALIDATION_FLAG]: flag,
          }))
            vi.stubEnv(name, value);
          // Key lookups read the process environment, where a blank key
          // counts as unset: the host's keys are the ones it stores, never
          // the shell's.
          for (const name of API_KEY_ENV_NAMES) vi.stubEnv(name, '');
        }),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      mkdirSync(storage, { recursive: true });
      if (workspace === undefined)
        return yield* Effect.die(
          'the validation host opens a workspace folder',
        );
      mkdirSync(workspace, { recursive: true });
      writeFileSync(flag, VALIDATION_FLAG_CONTENT);
      yield* AgentCatalog.use((catalog) => catalog.refresh).pipe(Effect.orDie);
      // A golden child's model is chosen among those a key makes available.
      yield* host.secrets
        .set(apiKeySecretName('openai'), 'validation-fake-key')
        .pipe(Effect.orDie);
      return host;
    }),
  );

/**
 * A session over `roots` (the installed host's, unless named) on the calling
 * block's process, its history in the root's SQLite store, opened as by a
 * host whose person answers from the view, so a request its runs open waits
 * for a decision. Returns the internal handle the suites drive runs on; the
 * session closes with the scope.
 */
export const persistentTestSession = (
  roots: WorkspaceRoots = testWorkspaceRoots(),
): Effect.Effect<
  Context.Context<SessionServices>,
  SessionOpenError,
  Sessions | SessionOwner | Scope.Scope
> =>
  Effect.flatMap(
    TestSession.open(roots, { persistent: true, host: {} }),
    sessionHandleOf,
  );

/** Wait, polling the file, until `ready` holds of the store's rows. */
export const untilStored = (
  storage: string,
  ready: (rows: readonly StoredRow[]) => boolean,
): Effect.Effect<void, Cause.TimeoutError> =>
  Effect.gen(function* () {
    while (!ready(storedRows(storage))) yield* Effect.sleep('20 millis');
  }).pipe(Effect.timeout('30 seconds'));

const decodeMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      payload: Schema.Struct({
        kind: Schema.String,
        turn: Schema.optional(
          Schema.Struct({
            content: Schema.Array(
              Schema.Struct({
                kind: Schema.String,
                content: Schema.optional(
                  Schema.Array(
                    Schema.Struct({ text: Schema.optional(Schema.String) }),
                  ),
                ),
              }),
            ),
          }),
        ),
      }),
    }),
  ),
);

/** A committed model answer's text (a response that calls no tool), or
 *  null for any other row. */
export const answerOf = (row: StoredRow): string | null => {
  if (row.type !== 'model.message') return null;
  const { payload } = decodeMessage(row.data);
  const content = payload.turn?.content ?? [];
  if (
    payload.kind !== 'response' ||
    content.some((part) => part.kind === 'local-call')
  )
    return null;
  return content
    .flatMap((part) => part.content ?? [])
    .map((part) => part.text ?? '')
    .join('');
};

/** The texts of `runId`'s committed model answers, in order. */
export const answersOf = (storage: string, runId: RunId): string[] =>
  storedRows(storage).flatMap((row) => {
    const text = row.run === runId ? answerOf(row) : null;
    return text === null ? [] : [text];
  });

/** Whether `runId`'s newest position is parked waiting for input, after
 *  `answers` responses. */
export const parkedAfter =
  (runId: RunId, answers: number, storage: string) =>
  (rows: readonly StoredRow[]): boolean => {
    const last = rows.findLast(
      (row) => row.run === runId && row.type === 'run.position',
    );
    return (
      last !== undefined &&
      last.data.includes('"at":"waiting"') &&
      answersOf(storage, runId).length >= answers
    );
  };

/**
 * Launch a root run of the bundled `assistant` with `instruction` on
 * `session`, a session over the installed host's roots, and wait until it
 * answered and parked waiting for input. The launch lives in the caller's
 * scope.
 */
export const parkedRoot = (
  session: Context.Context<SessionServices>,
  instruction = 'Start here.',
): Effect.Effect<RunId, Cause.TimeoutError, SessionOwner | Scope.Scope> =>
  Effect.gen(function* () {
    const { storage } = testWorkspaceRoots();
    const runId = generateRunId();
    yield* rootRun({
      config: Schema.decodeUnknownSync(AgentConfigSchema)({
        agent: 'assistant',
        model: 'openai/gpt-5.6-sol',
        instruction,
      }),
      runId,
      interactive: true,
    }).pipe(Effect.provide(session), Effect.forkScoped);
    yield* untilStored(storage, parkedAfter(runId, 1, storage));
    return runId;
  });

/** A root run parked in a store whose process crashed, and the session
 *  opened over that store since. */
interface CrashedRun {
  readonly session: Context.Context<SessionServices>;
  readonly runId: RunId;
  readonly storage: string;
}

/**
 * Launch a root run of the bundled `assistant` with `instruction`, let it
 * answer and park waiting for input, then crash: the store's committed
 * state is copied as a killed process leaves it, and a session over the
 * copy opens for the caller's scope (`interactions` attached as its host).
 */
export const parkedRunAfterCrash = (
  options: {
    readonly instruction?: string;
    readonly interactions?: HostInteractions;
  } = {},
): Effect.Effect<CrashedRun, Error, Sessions | SessionOwner | Scope.Scope> =>
  Effect.gen(function* () {
    const roots = testWorkspaceRoots();
    // The session and the launch live in this scope: closing it is the
    // kill, and a setup that fails on the way kills it too.
    const { runId, storage } = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* persistentTestSession(roots);
        const runId = yield* parkedRoot(session, options.instruction);
        return { runId, storage: crashedCopy(roots.storage) };
      }),
    );
    const session = yield* persistentTestSession({ ...roots, storage });
    if (options.interactions !== undefined)
      yield* attachInteractions(
        Context.get(session, Interactions),
        options.interactions,
      );
    return { session, runId, storage };
  });
