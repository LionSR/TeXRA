/**
 * The direct LSP lane's core: every {@link LeanLanguageServices} operation as
 * an Effect over a `LayerMap` of {@link LeanServer}s keyed by workspace root.
 *
 * The map builds a root's server on first use, memoizes it, serializes
 * concurrent first-touch requests for the same root onto one build, and
 * releases a server that sits unused for the idle time-to-live. Each request
 * holds a lease (the map's reference count) for its duration. The pool's own
 * bookkeeping is one `Ref` of root to owners and leases: every agent run that
 * uses a server owns it until its run-end hook fires; a server whose final
 * owner ended is invalidated at once, or, while a lease is in flight, when
 * that lease ends. `restart_server` invalidates and rebuilds every root
 * (each on its own, so one failure does not interrupt a sibling); a spawn
 * that hits a full file table invalidates the idle roots, waits for the ones
 * already closing, and retries once. Closing the pool's scope ends the map
 * and every server.
 */

import { access } from 'node:fs/promises';
import * as path from 'node:path';

import {
  Context,
  Data,
  Deferred,
  type Duration,
  Effect,
  Layer,
  LayerMap,
  RcMap,
  Ref,
  Result,
  type Scope,
} from 'effect';

import { warn } from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { runLakeCommand } from './lakeCommands';
import { LeanServer, type LeanStartError } from './leanServer';
import type { ChildProcessSpawner } from 'effect/unstable/process';
import type { LeanLanguageServices } from '../leanLanguageServices';
import type {
  LeanFileCommand,
  LeanProjectCommand,
  FetchDiagnosticsResult,
  LspResult,
} from '../leanTypes';

const LOG_CHANNEL = 'lean.direct';

/**
 * Lake arguments for project commands that fan out across all active servers.
 * Commands absent here (restart_server, stop_server, install_elan, …) are
 * handled by their own dedicated branches.
 */
const LAKE_PROJECT_ARGS = {
  build: ['build'],
  clean: ['clean'],
  fetch_cache: ['exe', 'cache', 'get'],
  fetch_file_cache: ['exe', 'cache', 'get'],
} satisfies Partial<Record<LeanProjectCommand, readonly string[]>>;

/** The pool was disposed before or while this call ran. */
export class LeanAdapterStopped extends Data.TaggedError('LeanAdapterStopped') {
  override readonly message = 'Lean adapter was stopped.';
}

/** No `lakefile.lean` / `lakefile.toml` above the file. */
class LeanProjectNotFound extends Data.TaggedError('LeanProjectNotFound')<{
  readonly message: string;
}> {}

/** A project command could not run or reported failure. */
export class LeanProjectCommandError extends Data.TaggedError(
  'LeanProjectCommandError',
)<{ readonly message: string }> {}

export interface LeanServerPoolOptions {
  readonly lakeCommand: string;
  /** Release a server unused for this long; `Duration.infinity` never does. */
  readonly idleTimeToLive: Duration.Duration;
}

interface RootEntry {
  /** Set once the root's server has been leased; absent while it starts. */
  readonly server?: LeanServer['Service'];
  /** Runs that used this shared server and have not reached run end yet. */
  readonly owners: ReadonlySet<ExecutionId>;
  readonly leases: number;
  /** Final owner ended while a request was still leased. */
  readonly stopWhenIdle: boolean;
}

const EMPTY_ENTRY: RootEntry = {
  owners: new Set(),
  leases: 0,
  stopWhenIdle: false,
};

export class LeanServerPool extends Context.Service<
  LeanServerPool,
  {
    readonly fetchDiagnosticsForFile: (
      file: string,
      runId: ExecutionId | undefined,
    ) => Effect.Effect<FetchDiagnosticsResult>;
    readonly executeFileCommand: (
      command: LeanFileCommand,
      filePath: string,
      runId: ExecutionId | undefined,
    ) => Effect.Effect<boolean>;
    readonly executeProjectCommand: (
      command: LeanProjectCommand,
      runId: ExecutionId | undefined,
    ) => Effect.Effect<
      void,
      LeanProjectCommandError | LeanStartError | LeanAdapterStopped
    >;
    readonly positionRequest: <T>(
      filePath: string,
      line: number,
      column: number,
      method: string,
      runId: ExecutionId | undefined,
    ) => Effect.Effect<LspResult<T>>;
    /** See {@link LeanLanguageServices.stopSessionsForRun}. */
    readonly stopSessionsForRun: (runId: ExecutionId) => Effect.Effect<void>;
  }
>()('@texra/lean/LeanServerPool') {
  static readonly layer = (
    options: LeanServerPoolOptions,
  ): Layer.Layer<
    LeanServerPool,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > => Layer.effect(LeanServerPool)(make(options));
}

const make = Effect.fn('LeanServerPool.make')(function* ({
  lakeCommand,
  idleTimeToLive,
}: LeanServerPoolOptions) {
  const servers = yield* LayerMap.make(
    (root: string) => LeanServer.layer({ workspaceRoot: root, lakeCommand }),
    { idleTimeToLive },
  );
  const entries = yield* Ref.make<ReadonlyMap<string, RootEntry>>(new Map());
  const stopped = yield* Ref.make(false);
  // Registered after the map, so it runs before the map closes: a call that
  // lands during disposal fails as stopped rather than as interrupted.
  yield* Effect.addFinalizer(() => Ref.set(stopped, true));

  const updateEntry = (root: string, f: (entry: RootEntry) => RootEntry) =>
    Ref.update(entries, (map) =>
      new Map(map).set(root, f(map.get(root) ?? EMPTY_ENTRY)),
    );

  /** Roots whose server is live or still starting, dropping closed and never-started ones. */
  const liveEntries = Effect.gen(function* () {
    const live = new Map<string, RootEntry>();
    for (const [root, entry] of yield* Ref.get(entries)) {
      const gone = entry.server
        ? yield* Deferred.isDone(entry.server.closed)
        : entry.leases === 0;
      if (!gone) live.set(root, entry);
    }
    yield* Ref.set(entries, live);
    return live;
  });

  /**
   * Stop currently-idle other roots after EMFILE/ENFILE, then return so the
   * caller can retry the spawn. Wait for servers already closing so their
   * descriptors are gone first. Do not wait for busy servers: position RPCs
   * have no timeout, so one hung hover/goal would stall the start.
   */
  const evictOthersForExhausted = Effect.fn(
    'LeanServerPool.evictOthersForExhausted',
  )(function* (exceptRoot: string) {
    const live = yield* liveEntries;
    yield* Effect.forEach(
      [...live].filter(
        ([root, entry]) =>
          root !== exceptRoot && entry.leases === 0 && entry.server,
      ),
      ([root, entry]) =>
        servers
          .invalidate(root)
          .pipe(Effect.andThen(Deferred.await(entry.server!.closed))),
      { concurrency: 'unbounded', discard: true },
    );
  });

  /** The root's server, built on first use, in the caller's scope. */
  const serverFor = (root: string) =>
    servers.contextEffect(root).pipe(
      Effect.map((context) => Context.get(context, LeanServer)),
      // A failed build stays cached for the idle time otherwise.
      Effect.tapError(() => servers.invalidate(root)),
    );

  const acquire = Effect.fn('LeanServerPool.acquire')(function* (root: string) {
    if (yield* Ref.get(stopped)) return yield* new LeanAdapterStopped();
    // A server the map has already dropped but whose scope is still closing
    // keeps the root reserved: its replacement spawns once the old process
    // has released its descriptors.
    const previous = (yield* Ref.get(entries)).get(root)?.server;
    if (previous && !(yield* RcMap.has(servers.rcMap, root))) {
      yield* Deferred.await(previous.closed);
    }
    return yield* serverFor(root).pipe(
      Effect.catchIf(
        (error) => isFileTableExhausted(error),
        (error) =>
          Effect.gen(function* () {
            const others = [...(yield* liveEntries).keys()].some(
              (other) => other !== root,
            );
            if (!others) return yield* Effect.fail(error);
            warn(
              LOG_CHANNEL,
              `Lean spawn hit a full file table; stopping other servers and retrying (${toErrorMessage(error)})`,
            );
            yield* evictOthersForExhausted(root);
            return yield* serverFor(root);
          }),
      ),
    );
  });

  const release = Effect.fn('LeanServerPool.release')(function* (root: string) {
    const entry = yield* Ref.modify(entries, (map) => {
      const current = map.get(root);
      if (!current) return [undefined, map] as const;
      const next = { ...current, leases: Math.max(0, current.leases - 1) };
      return [next, new Map(map).set(root, next)] as const;
    });
    if (entry && entry.leases === 0 && entry.stopWhenIdle) {
      yield* servers.invalidate(root);
    }
  });

  /**
   * Lease the root's server for the caller's scope. The owner is recorded
   * before the readiness wait so a run end that lands meanwhile sees it; a
   * new owner supersedes a deferred stop. Uninterruptible where the lease
   * count and its release are paired, so neither can be left unmatched.
   */
  const lease = Effect.fn('LeanServerPool.lease')(function* (
    root: string,
    runId: ExecutionId | undefined,
  ) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* updateEntry(root, (entry) => {
          const newOwner = runId !== undefined && !entry.owners.has(runId);
          return {
            ...entry,
            owners: newOwner ? new Set(entry.owners).add(runId) : entry.owners,
            leases: entry.leases + 1,
            stopWhenIdle: newOwner ? false : entry.stopWhenIdle,
          };
        });
        yield* Effect.addFinalizer(() => release(root));
      }),
    );
    const server = yield* acquire(root);
    yield* updateEntry(root, (entry) =>
      entry.server === server ? entry : { ...entry, server },
    );
    return server;
  });

  const requireRoot = Effect.fn('LeanServerPool.requireRoot')(function* (
    filePath: string,
  ) {
    const absolute = path.resolve(filePath);
    const root = yield* resolveWorkspaceRoot(absolute);
    if (!root) {
      return yield* new LeanProjectNotFound({
        message: `No Lean project found for ${absolute}. Lake projects need a lakefile.lean or lakefile.toml in an ancestor directory.`,
      });
    }
    return root;
  });

  const withServer = <A, E>(
    filePath: string,
    runId: ExecutionId | undefined,
    use: (server: LeanServer['Service']) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* requireRoot(filePath);
        const server = yield* lease(root, runId);
        return yield* use(server);
      }),
    );

  const stop = (root: string, entry: RootEntry) =>
    servers
      .invalidate(root)
      .pipe(Effect.andThen(entry.server?.shutdown ?? Effect.void));

  /**
   * Run-end hook: release the ended run's ownership of every server it used.
   * A shared server survives while another run still owns it. If the final
   * owner ends during an in-flight request, the stop waits for the final
   * lease. Servers started outside any run have no owners and use the idle
   * time-to-live.
   */
  const stopSessionsForRun = Effect.fn('LeanServerPool.stopSessionsForRun')(
    function* (runId: ExecutionId) {
      const live = yield* liveEntries;
      const roots: string[] = [];
      for (const [root, entry] of live) {
        if (!entry.owners.has(runId)) continue;
        const owners = new Set(entry.owners);
        owners.delete(runId);
        const stopNow = owners.size === 0 && entry.leases === 0;
        yield* updateEntry(root, (current) => ({
          ...current,
          owners,
          stopWhenIdle:
            owners.size === 0 && entry.leases > 0 ? true : current.stopWhenIdle,
        }));
        if (stopNow) roots.push(root);
      }
      yield* Effect.forEach(roots, (root) => servers.invalidate(root), {
        concurrency: 'unbounded',
        discard: true,
      });
    },
  );

  const restart = Effect.fn('LeanServerPool.restart')(function* (
    root: string,
    entry: RootEntry,
    runId: ExecutionId | undefined,
  ) {
    yield* stop(root, entry);
    if (entry.server) yield* Deferred.await(entry.server.closed);
    yield* Effect.scoped(lease(root, runId));
  });

  const runLake = Effect.fn('LeanServerPool.runLake')(function* (
    roots: ReadonlyArray<string>,
    runId: ExecutionId | undefined,
    args: readonly string[],
  ) {
    if (roots.length === 0) {
      return yield* new LeanProjectCommandError({
        message: `No Lean project session active. Run a Lean tool against a file in your project first, then retry "${args.join(' ')}".`,
      });
    }
    // Leased for the command's duration: a build is server activity. The
    // lake commands serialize per workspace inside `runLakeCommand`, which
    // resolves with the exit code and never rejects on it.
    const results = yield* Effect.forEach(
      roots,
      (root) =>
        Effect.scoped(
          lease(root, runId).pipe(
            Effect.andThen(
              Effect.promise(() =>
                runLakeCommand({
                  workspaceRoot: root,
                  lakeCommand,
                  args,
                  serialize: true,
                }),
              ),
            ),
          ),
        ),
      { concurrency: 'unbounded' },
    );
    const failed = results.filter((r) => r.exitCode !== 0);
    if (failed.length > 0) {
      return yield* new LeanProjectCommandError({
        message: `lake ${args.join(' ')} failed in ${failed.length} workspace(s):\n${failed
          .map((r) => r.stderr.trim() || r.stdout.trim())
          .join('\n---\n')}`,
      });
    }
  });

  const executeProjectCommand = Effect.fn(
    'LeanServerPool.executeProjectCommand',
  )(function* (command: LeanProjectCommand, runId: ExecutionId | undefined) {
    // Project commands aren't tied to a file: they apply to every live root.
    const live = yield* liveEntries;
    switch (command) {
      case 'restart_server': {
        if (live.size === 0) {
          return yield* new LeanProjectCommandError({
            message: 'No Lean server running to restart.',
          });
        }
        // Every root gets its restart attempt: a failing respawn must not
        // interrupt a sibling's restart. The first failure is reported once
        // all have settled.
        const restarts = yield* Effect.forEach(
          live,
          ([root, entry]) => Effect.result(restart(root, entry, runId)),
          { concurrency: 'unbounded' },
        );
        const failed = restarts.find(Result.isFailure);
        if (failed) return yield* Effect.fail(failed.failure);
        return;
      }
      case 'stop_server':
        yield* Effect.forEach(live, ([root, entry]) => stop(root, entry), {
          concurrency: 'unbounded',
          discard: true,
        });
        return;
      // `fetch_file_cache` normally needs the active editor's file; we don't
      // have one in CLI/desktop, so it falls back to the project-wide cache
      // fetch (same as `fetch_cache`). All four fan out one lake-arg set per
      // live root via the LAKE_PROJECT_ARGS lookup.
      case 'build':
      case 'clean':
      case 'fetch_cache':
      case 'fetch_file_cache':
        yield* runLake([...live.keys()], runId, LAKE_PROJECT_ARGS[command]);
        return;
      case 'install_elan':
      case 'install_deps':
      case 'update_elan':
      case 'select_toolchain':
        return yield* new LeanProjectCommandError({
          message:
            `Command "${command}" is only available inside VS Code with the leanprover.lean4 extension. ` +
            'In CLI/desktop builds, run the matching shell command directly (see https://leanprover-community.github.io/install/linux.html).',
        });
    }
  });

  const fetchDiagnosticsForFile = Effect.fn(
    'LeanServerPool.fetchDiagnosticsForFile',
  )(function* (file: string, runId: ExecutionId | undefined) {
    return yield* withServer(file, runId, (server) =>
      server.diagnostics(file).pipe(
        Effect.map((diagnostics): FetchDiagnosticsResult => ({
          ok: true,
          diagnostics,
        })),
        Effect.catchTag(
          ['LeanSessionDisposed', 'LeanSessionNotRunning'],
          (error): Effect.Effect<FetchDiagnosticsResult> => {
            const message = toErrorMessage(error);
            warn(
              LOG_CHANNEL,
              `fetchDiagnosticsForFile: session interrupted for ${file}: ${message}`,
            );
            return Effect.succeed({
              ok: false,
              kind: 'toolchain_unavailable',
              message,
            });
          },
        ),
        Effect.catch((error): Effect.Effect<FetchDiagnosticsResult> => {
          // Opening/reading the file itself failed (e.g. ENOENT) — the file is
          // the problem, so the tool keeps its "could not open file" framing.
          const message = toErrorMessage(error);
          warn(
            LOG_CHANNEL,
            `fetchDiagnosticsForFile: could not read ${file}: ${message}`,
          );
          return Effect.succeed({ ok: false, kind: 'file_missing', message });
        }),
      ),
    ).pipe(
      Effect.catch((error): Effect.Effect<FetchDiagnosticsResult> => {
        // Server start covers both "not a Lake project" and a missing or
        // broken `lake`/`lean` toolchain — report it as toolchain_unavailable
        // so the tool can give actionable setup guidance instead of a generic
        // "could not open file".
        const message = toErrorMessage(error);
        warn(
          LOG_CHANNEL,
          `fetchDiagnosticsForFile: no Lean session for ${file}: ${message}`,
        );
        return Effect.succeed({
          ok: false,
          kind: 'toolchain_unavailable',
          message,
        });
      }),
    );
  });

  const executeFileCommand = Effect.fn('LeanServerPool.executeFileCommand')(
    function* (
      command: LeanFileCommand,
      filePath: string,
      runId: ExecutionId | undefined,
    ) {
      // Both file commands have the same effect from our point of view: drop
      // the cached open state and re-open with fresh contents.
      return yield* withServer(filePath, runId, (server) =>
        server.restartFile(filePath),
      ).pipe(
        Effect.as(true),
        // Return false (LeanFileTool surfaces it as a failure result) and log
        // the cause. Honors the `Promise<boolean>` contract so a missing/broken
        // `lake` doesn't throw out of the JSON-RPC path.
        Effect.catch((error) =>
          Effect.sync(() => {
            warn(
              LOG_CHANNEL,
              `executeFileCommand(${command}) failed for ${filePath}: ${toErrorMessage(error)}`,
            );
            return false;
          }),
        ),
      );
    },
  );

  const positionRequest = Effect.fn('LeanServerPool.positionRequest')(
    function* <T>(
      filePath: string,
      line: number,
      column: number,
      method: string,
      runId: ExecutionId | undefined,
    ) {
      return yield* withServer(filePath, runId, (server) =>
        server.requestSettled<T | null>(filePath, line, column, method),
      ).pipe(
        Effect.map((data): LspResult<T> =>
          data
            ? { data }
            : { data: null, error: 'Lean returned no data for this position.' },
        ),
        Effect.catch((error) =>
          Effect.succeed<LspResult<T>>({
            data: null,
            error: toErrorMessage(error),
          }),
        ),
      );
    },
  );

  return LeanServerPool.of({
    fetchDiagnosticsForFile,
    executeFileCommand,
    executeProjectCommand,
    positionRequest,
    stopSessionsForRun,
  });
});

function isFileTableExhausted(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 4; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code === 'EMFILE' || code === 'ENFILE') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Uses fs/promises directly — must not call platform() because this runs
// before initPlatform() during early startup / test harness setup.
const pathExists = (target: string): Effect.Effect<boolean> =>
  Effect.isSuccess(Effect.tryPromise(() => access(target)));

/** Walk up from `filePath` looking for a Lake project root. */
export const resolveWorkspaceRoot = Effect.fn(
  'LeanServerPool.resolveWorkspaceRoot',
)(function* (filePath: string) {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.parse(dir).root;
  for (;;) {
    if (
      (yield* pathExists(path.join(dir, 'lakefile.lean'))) ||
      (yield* pathExists(path.join(dir, 'lakefile.toml')))
    ) {
      return dir;
    }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
});
