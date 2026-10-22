/**
 * Faults injected into the real store, never a mocked one: the run engine's
 * suites drive real sessions over a real SQLite file and the validation
 * model, and fail, hold or crash that store where a case needs a race.
 *
 * - {@link sessionStoreFaults} arms faults on the `Database` the process
 *   holds for a persistent session's root, the instance the session graph
 *   borrows from `ProjectDatabases` (which has no other test seam): the next
 *   call of a named operation fails as the store fails (`DatabaseWriteFailed`
 *   or `DatabaseReadFailed`, nothing written), or waits, before it starts,
 *   until the case releases or fails it. `appendAll` may be narrowed to a
 *   batch holding one row type; a held `appendAll` or `job` holds the
 *   session's one publisher, as a slow commit does. Every operation runs the
 *   real store's code unless a fault is armed, and the faults go with the
 *   caller's scope.
 * - {@link parkedRunAfterCrash} is a process killed with a run parked: the
 *   committed store copied to a fresh root, claims held by a dead owner
 *   (or one the case names), and a fresh session opened over it.
 * - {@link validationHost} is the host those sessions run on: a temp-dir
 *   platform whose model is the validation model (`TEXRA_INTERNAL_VALIDATE_*`):
 *   a golden fixture agent plays its script, any other agent answers with
 *   what it was sent.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { type Cause, Deferred, Effect, RcMap, Ref, type Scope } from 'effect';
import { afterEach, beforeEach, vi } from 'vitest';

import { API_KEY_ENV_NAMES, apiKeySecretName } from '@texra-ai/llm';
import { AgentCatalog } from '@agent/index/agentCatalog';
import type {
  SessionHandle,
  SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import { withProcessServices } from '@platform/processRuntime';
import {
  AgentConfigSchema,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  DatabaseReadFailed,
  DatabaseWriteFailed,
  ProjectDatabases,
  type DatabaseOpenFailed,
} from '@shared/session/database';

import { generateRunId } from '@utils/core';
import { REPO_ROOT } from './repoScan';
import { fakeHostSecrets, setupPlatform } from './setupPlatform';
import { closeTestDefaultSession, openTestDefaultSession } from './sessionEnd';
import { createTempDirPlatform, useTempDirs } from './tempDirPlatform';
import { testRuntime } from './testProcessRuntime';
import { testWorkspaceRoots } from './testWorkspaceRoots';

const WRITES = ['appendAll', 'job', 'acquireClaims', 'releaseClaims'] as const;
const READS = [
  'readRunRecords',
  'readAggregate',
  'claimOwner',
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
  readonly rowType: SessionEventDraft['type'] | undefined;
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
    rowType?: SessionEventDraft['type'],
  ) => Effect.Effect<void>;
  /** The next matching call waits, before it starts, until the hold is
   *  released or failed; the faults' scope releases any hold left. */
  readonly holdNext: (
    operation: StoreOperation,
    rowType?: SessionEventDraft['type'],
  ) => Effect.Effect<StoreHold>;
}

/**
 * {@link StoreFaults} on the `Database` the test process holds for the
 * persistent session root `storage`: the instance the session's graph
 * borrows, so its readers and its publisher see the faults. The store is
 * borrowed, and its operations wrapped, for the caller's scope.
 */
export const sessionStoreFaults = (
  storage: string,
): Effect.Effect<StoreFaults, DatabaseOpenFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const databases = yield* withProcessServices(
      testRuntime(),
      Effect.gen(function* () {
        return yield* ProjectDatabases;
      }),
    );
    const database = yield* RcMap.get(databases, storage);
    const armed = yield* Ref.make<readonly Armed[]>([]);
    const matches = (entry: Armed, operation: string, args: unknown[]) =>
      entry.operation === operation &&
      (entry.rowType === undefined ||
        operation !== 'appendAll' ||
        (args[0] as readonly SessionEventDraft[]).some(
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
      return (WRITES as readonly string[]).includes(operation)
        ? new DatabaseWriteFailed({ path: storage, cause })
        : new DatabaseReadFailed({ path: storage, cause });
    };
    // cast: each operation is a function returning an Effect; the wrapper
    // forwards its arguments and result untouched.
    type Operation = (...args: unknown[]) => Effect.Effect<unknown, unknown>;
    const originals = Object.fromEntries(
      [...WRITES, ...READS].map((operation) => [
        operation,
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

/** A process of this host that is provably gone: its start never matches. */
const DEAD_OWNER = JSON.stringify([
  os.hostname().toLowerCase(),
  process.pid,
  'killed',
]);

/** The store's file in a session root. */
const storeFile = (storage: string) => join(storage, 'texra.db');

/**
 * Rebuild a copy of the clean store as a process killed after commit `n`
 * left it, its claims held by a dead owner: every durable table at the cut,
 * not the later store with rows cut away. Rows, their blobs and sequences
 * go back to commit `n`; a plugin aggregate hangs where its last fact at
 * the cut put it; current values and input history written after the cut's
 * clock go (one the later run overwrote in place reads as never written).
 * `stored_kind` is append-only and kept: every version in it is this
 * build's, so the gate reads it as it would at the cut.
 * The projections rebuild from the rows on open.
 */
export function crashAt(
  clean: string,
  storage: string,
  n: number,
  owner: string = DEAD_OWNER,
): void {
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
      DELETE FROM listing_entry; DELETE FROM run_usage; DELETE FROM run_model;
      DELETE FROM event_blob WHERE "commit" > ${n};
      DELETE FROM event WHERE "commit" > ${n};
      DELETE FROM event_sequence WHERE id NOT IN (SELECT aggregate FROM event);
      DELETE FROM blob WHERE digest NOT IN (SELECT digest FROM event_blob);
      UPDATE event_sequence SET
        seq = (SELECT max(seq) FROM event WHERE aggregate = event_sequence.id),
        closed_by = CASE WHEN closed_by > ${n} THEN NULL ELSE closed_by END,
        owner_id = CASE WHEN owner_id IS NULL THEN NULL ELSE '${owner}' END;
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
 * A process killed now: what the store at `storage` has committed, and the
 * run files beside it, copied to a fresh root with every claim held by a
 * dead owner (or by `owner`). Returns that root, for a fresh session to open.
 */
function crashedCopy(storage: string, owner?: string): string {
  const crashed = join(storage, `crashed-${Date.now()}`);
  const committed = join(storage, 'committed.db');
  const db = new DatabaseSync(storeFile(storage));
  let commit: number;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    commit = Number(
      db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'event'").get()
        ?.seq ?? 0,
    );
    db.exec(`VACUUM INTO '${committed}'`);
  } finally {
    db.close();
  }
  crashAt(committed, crashed, commit, owner);
  if (existsSync(join(storage, 'executions')))
    cpSync(join(storage, 'executions'), join(crashed, 'executions'), {
      recursive: true,
    });
  return crashed;
}

/** One stored run row, read straight from the file. */
export interface StoredRow {
  readonly commit: number;
  readonly run: string;
  readonly parent: string | null;
  readonly type: string;
  readonly data: string;
}

/** Every run row the store at `storage` holds, in commit order. */
export const storedRows = (storage: string): StoredRow[] => {
  const db = new DatabaseSync(storeFile(storage));
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
      .all() as unknown as StoredRow[];
  } finally {
    db.close();
  }
};

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
 * Register, for the calling `describe`, a temp-dir host whose agents are the
 * golden fixtures and the bundled personas and whose model is the
 * validation model: a golden agent plays its script, any other answers with
 * what it was sent. Each test starts with no default session open, and no
 * provider key from the shell: its keys are the ones its secrets store.
 */
export function validationHost(prefix: string): void {
  const tempDirs = useTempDirs();
  setupPlatform(async () => {
    const host = await createTempDirPlatform(prefix, tempDirs);
    const agents = {
      custom: () => Effect.succeed(AGENTS),
      customConfigured: () => Effect.succeed(false),
      builtIn: () => Effect.succeed(BUNDLED_AGENTS),
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
    // Key lookups read the process environment, where a blank key counts as
    // unset: the host's keys are the ones it stores, never the shell's.
    for (const name of API_KEY_ENV_NAMES) vi.stubEnv(name, '');
    mkdirSync(storage, { recursive: true });
    mkdirSync(workspace!, { recursive: true });
    writeFileSync(flag, 'texra-cli-run-validation\n');
    await testRuntime().runPromise(
      AgentCatalog.use((catalog) => catalog.refresh),
    );
    // A golden child's model is chosen among those a key makes available.
    await Effect.runPromise(
      fakeHostSecrets.set(apiKeySecretName('openai'), 'validation-fake-key'),
    );
    await Effect.runPromise(closeTestDefaultSession);
  });
  afterEach(async () => {
    await Effect.runPromise(closeTestDefaultSession);
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Who holds `runId`'s claim in the store at `storage`: an owner id, or
 *  null when the claim is let go (or the run has no row). */
export const claimHolder = (storage: string, runId: RunId): string | null => {
  const db = new DatabaseSync(storeFile(storage));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const row = db
      .prepare(
        "SELECT owner_id AS owner FROM event_sequence WHERE kind = 'run' AND logical_id = ?",
      )
      .get(runId);
    return typeof row?.owner === 'string' ? row.owner : null;
  } finally {
    db.close();
  }
};

/** Wait, polling the file, until `ready` holds of the store's rows. */
export const untilStored = (
  storage: string,
  ready: (rows: readonly StoredRow[]) => boolean,
): Effect.Effect<void, Cause.TimeoutError> =>
  Effect.gen(function* () {
    while (!ready(storedRows(storage))) yield* Effect.sleep('20 millis');
  }).pipe(Effect.timeout('30 seconds'));

/** The texts of `runId`'s committed model answers (responses that call no
 *  tool), in order. */
export const answersOf = (storage: string, runId: RunId): string[] =>
  storedRows(storage).flatMap((row) => {
    if (row.run !== runId || row.type !== 'model.message') return [];
    const { payload } = JSON.parse(row.data) as {
      readonly payload: {
        readonly kind: string;
        readonly turn?: {
          readonly content: readonly {
            readonly kind: string;
            readonly content?: readonly { readonly text?: string }[];
          }[];
        };
      };
    };
    const content = payload.turn?.content ?? [];
    if (
      payload.kind !== 'response' ||
      content.some((part) => part.kind === 'local-call')
    )
      return [];
    return [
      content
        .flatMap((part) => part.content ?? [])
        .map((part) => part.text ?? '')
        .join(''),
    ];
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
 * `session`, the default session over the process roots, and wait until it
 * answered and parked waiting for input. The launch lives in the caller's
 * scope.
 */
export const parkedRoot = (
  session: SessionHandle,
  instruction = 'Start here.',
): Effect.Effect<RunId, Cause.TimeoutError, Scope.Scope> =>
  Effect.gen(function* () {
    const { storage } = testWorkspaceRoots();
    const runId = generateRunId();
    yield* withProcessServices(
      testRuntime(),
      session.runs.launch({
        request: {
          config: AgentConfigSchema.parse({
            agent: 'assistant',
            model: 'gpt56',
            instruction,
          }),
          runId,
        },
        options: {},
      }),
    ).pipe(Effect.forkScoped);
    yield* untilStored(storage, parkedAfter(runId, 1, storage));
    return runId;
  });

/** A root run parked in a store whose process crashed, and the session
 *  opened over that store since. */
interface CrashedRun {
  readonly session: SessionHandle;
  readonly runId: RunId;
  readonly storage: string;
}

/**
 * Launch a root run of the bundled `assistant` with `instruction`, let it
 * answer and park waiting for input, then crash: the store's committed
 * state is copied as a killed process leaves it and the file's default
 * session opens over the copy (`interactions` its host's, `owner` holding
 * the run's claim instead of a dead process).
 */
export const parkedRunAfterCrash = (
  options: {
    readonly instruction?: string;
    readonly interactions?: SessionHandleInit['interactions'];
    readonly owner?: string;
  } = {},
): Effect.Effect<CrashedRun, Error> =>
  Effect.gen(function* () {
    const roots = testWorkspaceRoots();
    const session = yield* openTestDefaultSession({ roots });
    // The launch lives in this scope: closing it, after the session, is the
    // kill, and a setup that fails on the way kills it too.
    const { runId, storage } = yield* Effect.scoped(
      Effect.gen(function* () {
        const runId = yield* parkedRoot(session, options.instruction);
        const copy = crashedCopy(roots.storage, options.owner);
        yield* closeTestDefaultSession;
        return { runId, storage: copy };
      }),
    );
    const reopened = yield* openTestDefaultSession({
      roots: { ...roots, storage },
      ...(options.interactions && { interactions: options.interactions }),
    });
    return { session: reopened, runId, storage };
  });
