/**
 * The {@link LeanLanguageServices} port over `lake env lean --server`, for
 * hosts without a VS Code extension bridge (Electron desktop, CLI, the agent
 * package): every operation as an Effect over a `LayerMap` of
 * {@link LeanServer}s keyed by workspace root.
 *
 * The map builds a root's server on first use, serializes concurrent
 * first-touch requests for the same root onto one build, and counts the
 * references to it. A call holds one for its duration, and one more in the
 * scope the caller provides (its run's), so a server lives while a run that
 * used it lives or a call uses it, and stops when the last of them ends.
 * `restart_server` stops and restarts every root (each on its own, so one
 * failure does not interrupt a sibling); a spawn that hits a full file table
 * stops the other servers and retries once. Closing the layer's scope ends
 * the map and its servers. Nothing is spawned until a Lean tool is invoked.
 */

import * as path from 'node:path';

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  LayerMap,
  Option,
  Predicate,
  RcMap,
  Result,
  Schema,
  Scope,
} from 'effect';

import { ChildProcessSpawner } from 'effect/process';
import { withLogChannel } from '@texra-ai/harness/plugins';
import { pathExists } from '@texra-ai/harness/node';
import { toErrorMessage } from '@texra-ai/harness/schemas';

import { runLakeCommand } from './lakeCommands';
import { LeanServer, type LeanStartError } from './leanServer';
import { LeanLanguageServices } from '../leanLanguageServices';
import {
  LeanFileCommandFailed,
  LeanFileUnreadable,
  LeanUnavailable,
  LspHoverSchema,
  PlainGoalSchema,
  PlainTermGoalSchema,
  type LeanProjectCommand,
  type LspResult,
} from '../leanTypes';
import type { LeanServerInfo } from '../leanServerInfo';

const LOG_CHANNEL = 'lean.direct';

/**
 * Lake arguments for project commands that fan out across all active servers.
 * The server commands (restart_server, stop_server) have own branches.
 */
const LAKE_PROJECT_ARGS = {
  build: ['build'],
  clean: ['clean'],
  fetch_cache: ['exe', 'cache', 'get'],
  fetch_file_cache: ['exe', 'cache', 'get'],
} satisfies Partial<Record<LeanProjectCommand, readonly string[]>>;

/**
 * The session errors that mean the root's server ended under the call or its
 * connection closed: a stop or a crash, never a missing toolchain. A request
 * error is the server's answer, not an end, so it is not one of them.
 */
const SERVER_ENDED = [
  'LeanSessionNotRunning',
  'JsonRpcConnectionDisposed',
] as const;

/** The root's server ended under the call: it was stopped or crashed. */
const serverStopped = (error: Error): LeanUnavailable =>
  new LeanUnavailable({
    message: `The Lean server stopped: ${error.message}`,
    cause: error,
  });

/** No `lake env lean --server` could be started for the root. */
const noToolchain = (error: LeanStartError): LeanUnavailable =>
  new LeanUnavailable({
    message: `${error.message}\n\nInstall elan so that \`lake\` is on PATH (https://leanprover-community.github.io/install/).`,
    cause: error,
  });

/** A project command could not run or reported failure. */
class LeanProjectCommandError extends Schema.TaggedError<LeanProjectCommandError>()(
  'LeanProjectCommandError',
  {
    message: Schema.String,
  },
) {}

/** A root the map holds, with its server's start once it has finished. */
interface HeldRoot {
  readonly root: string;
  /** Absent while the server starts. */
  readonly start?: Exit.Exit<Context.Context<LeanServer>, LeanStartError>;
}

/** The started server of `held`, if its start succeeded. */
const startedServer = ({ start }: HeldRoot) =>
  start && Exit.isSuccess(start)
    ? Context.get(start.value, LeanServer)
    : undefined;

const make = Effect.fn('LeanServerPool.make')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // No idle time-to-live: a server stops as soon as its last reference ends.
  const servers = yield* LayerMap.make((root: string) =>
    LeanServer.layer({ workspaceRoot: root }),
  );

  /** Every root the map holds now, read off the map itself. */
  const heldRoots = Effect.suspend(() => {
    const { state } = servers.rcMap;
    if (state._tag === 'Closed') return Effect.succeed([]);
    return Effect.forEach(
      [...state.map],
      ([root, entry]): Effect.Effect<HeldRoot> =>
        Deferred.poll(entry.deferred).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed({ root }),
              onSome: (start) =>
                Effect.map(Effect.exit(start), (exit) => ({
                  root,
                  start: exit,
                })),
            }),
          ),
        ),
    );
  });

  /** Drop the root from the map and stop its server now, if it started. */
  const stop = (held: HeldRoot) =>
    servers
      .invalidate(held.root)
      .pipe(Effect.andThen(startedServer(held)?.shutdown ?? Effect.void));

  /** The root's server, built on first use, held in the caller's scope. */
  const serverFor = (root: string) =>
    servers.contextEffect(root).pipe(
      Effect.map((context) => Context.get(context, LeanServer)),
      // A failed build stays in the map otherwise.
      Effect.tapError(() => servers.invalidate(root)),
    );

  /**
   * The root's server. A spawn that finds the file table full stops the
   * other started servers, whose descriptors that frees, and retries once.
   */
  const acquire = Effect.fn('LeanServerPool.acquire')(function* (root: string) {
    return yield* serverFor(root).pipe(
      Effect.catchIf(
        (error) => isFileTableExhausted(error),
        Effect.fnUntraced(function* (error) {
          const others = (yield* heldRoots).filter(
            (held) => held.root !== root && startedServer(held),
          );
          if (others.length === 0) return yield* Effect.fail(error);
          yield* Effect.logWarning(
            `Lean spawn hit a full file table; stopping other servers and retrying (${toErrorMessage(error)})`,
          ).pipe(withLogChannel(LOG_CHANNEL));
          yield* Effect.forEach(others, stop, {
            concurrency: 'unbounded',
            discard: true,
          });
          return yield* serverFor(root);
        }),
      ),
    );
  });

  /**
   * The root's server, held for the caller's scope and, once started, in
   * `owner` too. `owner`'s reference is taken only after the start, so a
   * failed start is released with the call.
   */
  const lease = Effect.fn('LeanServerPool.lease')(function* (
    root: string,
    owner: Scope.Scope,
  ) {
    const server = yield* acquire(root);
    yield* RcMap.getOption(servers.rcMap, root).pipe(Scope.provide(owner));
    return server;
  });

  const requireRoot = Effect.fn('LeanServerPool.requireRoot')(function* (
    filePath: string,
  ) {
    const absolute = path.resolve(filePath);
    const root = yield* resolveWorkspaceRoot(fs, absolute);
    if (!root) {
      return yield* new LeanUnavailable({
        message: `No Lean project found for ${absolute}. Lake projects need a lakefile.lean or lakefile.toml in an ancestor directory.`,
      });
    }
    return root;
  });

  const withServer = <A, E>(
    filePath: string,
    use: (server: LeanServer['Service']) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const owner = yield* Scope.Scope;
      const root = yield* requireRoot(filePath);
      return yield* Effect.scoped(Effect.flatMap(lease(root, owner), use));
    });

  const runLake = Effect.fn('LeanServerPool.runLake')(function* (
    roots: ReadonlyArray<string>,
    owner: Scope.Scope,
    args: readonly string[],
  ) {
    if (roots.length === 0) {
      return yield* new LeanProjectCommandError({
        message: `No Lean project session active. Run a Lean tool against a file in your project first, then retry "${args.join(' ')}".`,
      });
    }
    // Leased for the command's duration: a build is server activity.
    const results = yield* Effect.forEach(
      roots,
      (root) =>
        Effect.scoped(
          lease(root, owner).pipe(
            Effect.andThen(
              runLakeCommand({
                workspaceRoot: root,
                args,
              }).pipe(
                Effect.provideService(
                  ChildProcessSpawner.ChildProcessSpawner,
                  spawner,
                ),
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
  )(function* (command: LeanProjectCommand) {
    const owner = yield* Scope.Scope;
    // Project commands aren't tied to a file: they apply to every root whose
    // server is starting or started.
    const live = (yield* heldRoots).filter(
      (held) => !held.start || Exit.isSuccess(held.start),
    );
    switch (command) {
      case 'restart_server': {
        if (live.length === 0) {
          return yield* new LeanProjectCommandError({
            message: 'No Lean server running to restart.',
          });
        }
        // Every root gets its restart attempt: a failing respawn must not
        // interrupt a sibling's. The first failure is reported once all finish.
        const restarts = yield* Effect.forEach(
          live,
          (held) =>
            Effect.result(
              stop(held).pipe(
                Effect.andThen(Effect.scoped(lease(held.root, owner))),
              ),
            ),
          { concurrency: 'unbounded' },
        );
        const failed = restarts.find(Result.isFailure);
        if (failed) return yield* Effect.fail(failed.failure);
        return;
      }
      case 'stop_server':
        yield* Effect.forEach(live, stop, {
          concurrency: 'unbounded',
          discard: true,
        });
        return;
      // `fetch_file_cache` normally needs the active editor's file; CLI and
      // desktop have none, so it falls back to the project-wide fetch (same
      // as `fetch_cache`). All four fan out one LAKE_PROJECT_ARGS set per root.
      case 'build':
      case 'clean':
      case 'fetch_cache':
      case 'fetch_file_cache':
        yield* runLake(
          live.map((held) => held.root),
          owner,
          LAKE_PROJECT_ARGS[command],
        );
        return;
    }
  });

  const fetchDiagnosticsForFile = (file: string) =>
    withServer(file, (server) => server.diagnostics(file)).pipe(
      Effect.catchTag(SERVER_ENDED, (error) =>
        Effect.fail(serverStopped(error)),
      ),
      Effect.catchTag('LeanStartError', (error) =>
        Effect.fail(noToolchain(error)),
      ),
      // Reading the folders above the file for its project failed (e.g.
      // ENOENT): the file is the problem, so the tool keeps its "could not
      // open file" framing, as a failed read of the file itself does.
      Effect.catchTag('PlatformError', (error) =>
        Effect.fail(
          new LeanFileUnreadable({ message: error.message, cause: error }),
        ),
      ),
      // Diagnostics only send notifications, so no request can be refused:
      // a request error here is a defect, never a file's verdict.
      Effect.catchTag('JsonRpcRequestError', (error) => Effect.die(error)),
      Effect.tapError((error) =>
        Effect.logWarning(
          `fetchDiagnosticsForFile: no diagnostics for ${file}: ${error.message}`,
        ).pipe(withLogChannel(LOG_CHANNEL)),
      ),
      Effect.withSpan('LeanServerPool.fetchDiagnosticsForFile'),
    );

  // Both file commands have the same effect from our point of view: drop
  // the cached open state and re-open with fresh contents.
  const executeFileCommand = (filePath: string) =>
    withServer(filePath, (server) => server.restartFile(filePath)).pipe(
      Effect.catchTag(SERVER_ENDED, (error) =>
        Effect.fail(serverStopped(error)),
      ),
      Effect.catchTag('LeanStartError', (error) =>
        Effect.fail(noToolchain(error)),
      ),
      Effect.catchTag(
        ['LeanFileUnreadable', 'PlatformError', 'JsonRpcRequestError'],
        (error) =>
          Effect.fail(
            new LeanFileCommandFailed({
              message: error.message,
              cause: error,
            }),
          ),
      ),
      Effect.withSpan('LeanServerPool.executeFileCommand'),
    );

  /** `reply` decodes Lean's non-null answer; a mismatch is the result's error. */
  const positionRequest = <T>(
    filePath: string,
    line: number,
    column: number,
    method: string,
    reply: Schema.Codec<T, unknown>,
  ) =>
    withServer(filePath, (server) =>
      server.requestSettled(filePath, line, column, method),
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.NullOr(reply))),
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
      Effect.withSpan('LeanServerPool.positionRequest', {
        attributes: { method },
      }),
    );

  const listServers = Effect.flatMap(heldRoots, (held) =>
    Effect.forEach(held, ({ root, start }): Effect.Effect<LeanServerInfo> => {
      const base = { workspaceRoot: root, mode: 'direct-lsp' } as const;
      if (!start) return Effect.succeed({ ...base, status: 'starting' });
      return Exit.isSuccess(start)
        ? Context.get(start.value, LeanServer).info
        : Effect.succeed({
            ...base,
            status: 'error',
            errorMessage: Option.match(Cause.findErrorOption(start.cause), {
              onNone: () => 'The Lean server failed to start.',
              onSome: (error) => error.message,
            }),
          });
    }),
  );

  return LeanLanguageServices.of({
    listServers,
    fetchDiagnosticsForFile,
    executeFileCommand: (_command, filePath) => executeFileCommand(filePath),
    executeProjectCommand,
    getGoalState: (filePath, line, column) =>
      positionRequest(
        filePath,
        line,
        column,
        '$/lean/plainGoal',
        PlainGoalSchema,
      ),
    getTermGoal: (filePath, line, column) =>
      positionRequest(
        filePath,
        line,
        column,
        '$/lean/plainTermGoal',
        PlainTermGoalSchema,
      ),
    getHoverInfo: (filePath, line, column) =>
      positionRequest(
        filePath,
        line,
        column,
        'textDocument/hover',
        LspHoverSchema,
      ),
  });
});

function isFileTableExhausted(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 4; depth += 1) {
    const code = Predicate.hasProperty(current, 'code')
      ? current.code
      : undefined;
    if (code === 'EMFILE' || code === 'ENFILE') return true;
    current = Predicate.hasProperty(current, 'cause')
      ? current.cause
      : undefined;
  }
  return false;
}

/** Walk up from `filePath` looking for a Lake project root. */
const resolveWorkspaceRoot = Effect.fn('LeanServerPool.resolveWorkspaceRoot')(
  function* (fs: FileSystem.FileSystem, filePath: string) {
    let dir = path.dirname(path.resolve(filePath));
    const root = path.parse(dir).root;
    for (;;) {
      // Both lakefiles are probed at once; the answer is read as the
      // sequential `lean || toml` would, so a failed `.toml` probe counts
      // only when there is no `lakefile.lean`.
      const [lean, toml] = yield* Effect.all(
        [
          pathExists(fs, path.join(dir, 'lakefile.lean')),
          pathExists(fs, path.join(dir, 'lakefile.toml')),
        ],
        { concurrency: 2, mode: 'result' },
      );
      if ((yield* Effect.fromResult(lean)) || (yield* Effect.fromResult(toml)))
        return dir;
      if (dir === root) return null;
      dir = path.dirname(dir);
    }
  },
);

/**
 * The port over servers spawned with `lake` from `PATH`. The process runtime
 * builds it once, over the process's `ChildProcessSpawner` and `FileSystem`.
 */
export const directLeanLanguageServices: Layer.Layer<
  LeanLanguageServices,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> = Layer.effect(LeanLanguageServices)(make());
