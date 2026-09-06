/**
 * One Lean LSP server per workspace root, as a scoped service.
 *
 * `LeanServer.layer(options)` spawns `lake env lean --server` from the
 * project root through the `ChildProcessSpawner`, runs the JSON-RPC pipeline
 * over the child's stdio, completes the `initialize` handshake racing the
 * process exit (a spawn failure or early death fails the layer with
 * {@link LeanStartError}, keeping the errno for the pool's file-table
 * retry), and handles `textDocument/didOpen` lazily on the first request
 * that touches a file. Diagnostics arrive via `publishDiagnostics` and are
 * buffered per file; position requests wait for a quiet window first.
 *
 * Release is the scope's finalizers, in order: the shutdown protocol
 * (`shutdown` request under its bound, `exit`, SIGTERM, wait, SIGKILL, wait),
 * the JSON-RPC close, the process stop (a no-op once the protocol ran), the
 * registry entry. Every wait is on the runtime clock.
 *
 * Lives under `src/tools/lean/direct/` (host-neutral): Node-only, no `vscode`
 * imports, suitable for both the CLI and the desktop main process.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Layer,
  type PlatformError,
  Ref,
  Result,
  type Scope,
  Stream,
} from 'effect';
import {
  ChildProcess,
  type ChildProcessSpawner,
} from 'effect/unstable/process';

import { debug, info, warn } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { DiagnosticSeverity } from '@utils/diagnostics/diagnosticFormatting';
import {
  registerLeanServer,
  unregisterLeanServer,
  updateLeanServer,
} from '../leanServerRegistry';
import {
  makeJsonRpcConnection,
  type JsonRpcConnection,
  type JsonRpcConnectionDisposed,
  type JsonRpcRequestError,
} from './jsonRpc';
import type {
  LeanDiagnostic,
  LspDiagnostic,
  LspPublishDiagnosticsParams,
} from '../leanTypes';

const LOG_CHANNEL = 'lean.direct';

const LEAN_LANGUAGE_ID = 'lean4';
const HANDSHAKE_TIMEOUT = Duration.millis(15_000);
const SHUTDOWN_TIMEOUT = Duration.millis(2_000);
const DIAGNOSTICS_WAIT = Duration.millis(10_000);
const DIAGNOSTICS_QUIET_WINDOW_MS = 400;
const STDERR_TAIL_LIMIT = 4096;

/** The server was disposed, or the file state a wait was pinned to is gone. */
class LeanSessionDisposed extends Data.TaggedError('LeanSessionDisposed') {
  override readonly message = 'Lean session has been disposed.';
}

/** No live server: already exited, or shut down. */
class LeanSessionNotRunning extends Data.TaggedError('LeanSessionNotRunning') {
  override readonly message = 'Lean session is not running';
}

/** The server could not be spawned or did not complete `initialize`. */
export class LeanStartError extends Data.TaggedError('LeanStartError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The file to open could not be read from disk. */
class LeanFileReadError extends Data.TaggedError('LeanFileReadError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type LeanSessionError =
  | LeanSessionDisposed
  | LeanSessionNotRunning
  | LeanFileReadError
  | JsonRpcRequestError
  | JsonRpcConnectionDisposed;

export interface LeanServerOptions {
  readonly workspaceRoot: string;
  readonly lakeCommand: string;
}

export class LeanServer extends Context.Service<
  LeanServer,
  {
    readonly workspaceRoot: string;
    /** Settles once the scope has fully released the process. */
    readonly closed: Deferred.Deferred<void>;
    readonly isRunning: Effect.Effect<boolean>;
    /**
     * Run the shutdown protocol now, ahead of the scope's release (which
     * then finds nothing left to do). Idempotent; concurrent callers join.
     */
    readonly shutdown: Effect.Effect<void>;
    readonly diagnostics: (
      filePath: string,
    ) => Effect.Effect<LeanDiagnostic[], LeanSessionError>;
    /**
     * Open the file (if needed), wait for Lean's diagnostics to settle, and
     * send a position-scoped LSP request. Position requests like
     * `$/lean/plainGoal` return stale data if the elaborator hasn't finished:
     * the quiet-window wait is the only way to get correct goal state.
     */
    readonly requestSettled: <T>(
      filePath: string,
      line: number,
      column: number,
      method: string,
    ) => Effect.Effect<T, LeanSessionError>;
    /** Drop the cached open state and re-open with fresh contents. */
    readonly restartFile: (
      filePath: string,
    ) => Effect.Effect<void, LeanSessionError>;
  }
>()('@texra/lean/LeanServer') {
  static readonly layer = (
    options: LeanServerOptions,
  ): Layer.Layer<
    LeanServer,
    LeanStartError,
    ChildProcessSpawner.ChildProcessSpawner
  > => Layer.effect(LeanServer)(make(options));
}

interface OpenedFile {
  version: number;
  diagnostics: LeanDiagnostic[];
  lastDiagnosticsAt: number;
  /** Completed by the next `publishDiagnostics`; failed when the state is abandoned. */
  next: Deferred.Deferred<void, LeanSessionDisposed>;
}

interface ServerEnd {
  readonly status: 'stopped' | 'error';
  readonly message?: string;
  /** The spawn errno (EMFILE, ENOENT, ...), when that is what ended it. */
  readonly cause?: unknown;
}

/** Registry ids are per instance: an old server closing must not clobber its replacement's entry. */
let serverSequence = 0;

function spawnFailure(error: PlatformError.PlatformError): LeanStartError {
  const cause = error.reason.cause ?? error;
  return new LeanStartError({
    message: `Failed to spawn 'lake env lean --server': ${toErrorMessage(cause)}`,
    cause,
  });
}

function describeEnd(
  result: Result.Result<
    ChildProcessSpawner.ExitCode,
    PlatformError.PlatformError
  >,
): ServerEnd {
  if (Result.isSuccess(result)) {
    return result.success === 0
      ? { status: 'stopped' }
      : {
          status: 'error',
          message: `Server exited with code ${result.success}`,
        };
  }
  const { reason } = result.failure;
  if (reason._tag !== 'BadArgument' && reason.syscall?.startsWith('spawn')) {
    const start = spawnFailure(result.failure);
    return { status: 'error', message: start.message, cause: start.cause };
  }
  return {
    status: 'error',
    message: `Server ended: ${reason.description ?? result.failure.message}`,
    cause: reason.cause,
  };
}

/** SIGTERM a live process and wait for its stdio to close, escalating to SIGKILL. */
const stopProcess = Effect.fn('LeanServer.stopProcess')(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
) {
  yield* handle
    .kill({ forceKillAfter: SHUTDOWN_TIMEOUT })
    .pipe(
      Effect.catch((error) =>
        Effect.sync(() => debug(LOG_CHANNEL, `kill failed: ${error.message}`)),
      ),
    );
  yield* Effect.ignore(handle.exitCode).pipe(
    Effect.timeoutOption(SHUTDOWN_TIMEOUT),
  );
});

const make = ({
  workspaceRoot: root,
  lakeCommand,
}: LeanServerOptions): Effect.Effect<
  LeanServer['Service'],
  LeanStartError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    serverSequence += 1;
    const id = `direct:${root}#${serverSequence}`;
    const closed = yield* Deferred.make<void>();
    const ended = yield* Deferred.make<ServerEnd>();
    const openFiles = new Map<string, OpenedFile>();
    const clock = yield* Clock.clockWith(Effect.succeed);

    registerLeanServer({
      id,
      workspaceRoot: root,
      mode: 'direct-lsp',
      status: 'starting',
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => unregisterLeanServer(id)).pipe(
        Effect.andThen(Deferred.succeed(closed, undefined)),
      ),
    );

    const handle = yield* ChildProcess.make(lakeCommand, [
      'env',
      'lean',
      '--server',
    ]).pipe(ChildProcess.setCwd(root), Effect.mapError(spawnFailure));
    yield* Effect.addFinalizer(() => stopProcess(handle));

    const stderrTail = yield* Ref.make('');
    yield* Effect.forkScoped(
      handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderrTail, (tail) => {
            warn(LOG_CHANNEL, `[${root}] ${chunk.trimEnd()}`);
            return (tail + chunk).slice(-STDERR_TAIL_LIMIT);
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            debug(LOG_CHANNEL, `[${root}] stderr ended: ${error.message}`),
          ),
        ),
      ),
    );

    /** Fail every pending diagnostics wait and forget the open files. */
    const abandonFiles = Effect.gen(function* () {
      for (const state of openFiles.values()) {
        yield* Deferred.fail(state.next, new LeanSessionDisposed());
      }
      openFiles.clear();
    });

    const handlePublishDiagnostics = (params: LspPublishDiagnosticsParams) =>
      Effect.gen(function* () {
        const absolute = fileUriToPath(params.uri);
        if (!absolute) return;
        const state = openFiles.get(absolute);
        if (!state) return;
        state.diagnostics = params.diagnostics.map(toLeanDiagnostic);
        state.lastDiagnosticsAt = yield* Clock.currentTimeMillis;
        // Wake the quiet-window waiters; each re-arms on the fresh deferred.
        const arrived = state.next;
        state.next = Deferred.makeUnsafe();
        yield* Deferred.succeed(arrived, undefined);
      });

    const rpc: JsonRpcConnection = yield* makeJsonRpcConnection({
      input: handle.stdout,
      output: handle.stdin,
      onNotification: (method, params) => {
        switch (method) {
          case 'textDocument/publishDiagnostics':
            return handlePublishDiagnostics(
              params as LspPublishDiagnosticsParams,
            );
          case 'window/logMessage':
            return Effect.sync(() =>
              debug(LOG_CHANNEL, `[${root}] ${JSON.stringify(params)}`),
            );
          case 'window/showMessage':
            return Effect.sync(() =>
              info(LOG_CHANNEL, `[${root}] ${JSON.stringify(params)}`),
            );
          default:
            return Effect.void;
        }
      },
    });

    // The server is gone: record its end, drop file state, close the
    // connection with the end as the reason.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const end = describeEnd(yield* Effect.result(handle.exitCode));
        const tail = (yield* Ref.get(stderrTail)).slice(-1000);
        info(
          LOG_CHANNEL,
          `lake env lean --server ended (${end.message ?? 'exit code 0'}) at ${root}${tail ? `\n${tail}` : ''}`,
        );
        updateLeanServer(id, { status: end.status, errorMessage: end.message });
        yield* abandonFiles;
        yield* rpc.close(end.message ?? 'Lean server stopped');
        yield* Deferred.succeed(ended, end);
      }),
    );

    // The server ended before `initialize` completed. The cause is kept: the
    // pool's file-table retry matches EMFILE/ENFILE on it.
    const endedBeforeReady = Deferred.await(ended).pipe(
      Effect.flatMap((end) =>
        Effect.fail(
          new LeanStartError({
            message: end.message ?? 'Lean server stopped',
            cause: end.cause,
          }),
        ),
      ),
    );
    yield* rpc
      .request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'texra-direct-lsp' },
        rootUri: pathToUri(root),
        workspaceFolders: [{ uri: pathToUri(root), name: path.basename(root) }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false, willSave: false },
            hover: { contentFormat: ['plaintext', 'markdown'] },
            publishDiagnostics: {},
          },
          workspace: {},
        },
      })
      .pipe(
        Effect.raceFirst(endedBeforeReady),
        Effect.timeoutOrElse({
          duration: HANDSHAKE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new LeanStartError({ message: 'Lean LSP initialize timeout' }),
            ),
        }),
        Effect.catchTag(
          ['JsonRpcRequestError', 'JsonRpcConnectionDisposed'],
          (error) =>
            Effect.fail(
              new LeanStartError({ message: error.message, cause: error }),
            ),
        ),
      );
    yield* rpc.notify('initialized', {});
    updateLeanServer(id, { status: 'running' });

    const shutdown = yield* Effect.cached(
      Effect.gen(function* () {
        info(LOG_CHANNEL, `Stopping Lean server at ${root}`);
        yield* rpc.request('shutdown').pipe(
          Effect.timeoutOrElse({
            duration: SHUTDOWN_TIMEOUT,
            orElse: () =>
              Effect.sync(() =>
                debug(
                  LOG_CHANNEL,
                  `[${root}] shutdown request timed out after ${Duration.toMillis(SHUTDOWN_TIMEOUT)}ms`,
                ),
              ),
          }),
          Effect.catch((error) =>
            Effect.sync(() =>
              debug(
                LOG_CHANNEL,
                `[${root}] shutdown request failed: ${toErrorMessage(error)}`,
              ),
            ),
          ),
        );
        yield* rpc.notify('exit');
        yield* stopProcess(handle);
        // The end watcher closes the connection with the exit as its reason;
        // wait for it so a caller sees the server fully ended, bounded like
        // every other step of the protocol.
        yield* Deferred.await(ended).pipe(
          Effect.timeoutOption(SHUTDOWN_TIMEOUT),
        );
      }).pipe(Effect.uninterruptible, Effect.withSpan('LeanServer.shutdown')),
    );
    yield* Effect.addFinalizer(() => shutdown);

    /** The live connection, or `LeanSessionNotRunning`. */
    const requireRpc = Effect.gen(function* () {
      if (yield* Deferred.isDone(ended)) {
        return yield* new LeanSessionNotRunning();
      }
      return rpc;
    });

    const ensureFileOpen = Effect.fn('LeanServer.ensureFileOpen')(function* (
      absolute: string,
      forceReload: boolean,
    ) {
      yield* requireRpc;
      if (openFiles.has(absolute) && !forceReload) return;
      // Uses fs/promises directly rather than platform().fs: this must read the
      // same real on-disk bytes the spawned `lean --server` process itself sees,
      // not a host's virtual/faked workspace fs.
      const text = yield* Effect.tryPromise({
        try: (signal) => readFile(absolute, { encoding: 'utf8', signal }),
        catch: (error) =>
          new LeanFileReadError({
            message: `Failed to read ${absolute}: ${toErrorMessage(error)}`,
            cause: error,
          }),
      });
      const existing = openFiles.get(absolute);
      if (existing && !forceReload) return;
      // Re-check after the read: the server may have ended meanwhile.
      const live = yield* requireRpc;
      const version = (existing?.version ?? 0) + 1;
      if (existing) {
        existing.version = version;
        existing.diagnostics = [];
        existing.lastDiagnosticsAt = 0;
        yield* live.notify('textDocument/didChange', {
          textDocument: { uri: pathToUri(absolute), version },
          contentChanges: [{ text }],
        });
      } else {
        openFiles.set(absolute, {
          version,
          diagnostics: [],
          lastDiagnosticsAt: 0,
          next: Deferred.makeUnsafe(),
        });
        yield* live.notify('textDocument/didOpen', {
          textDocument: {
            uri: pathToUri(absolute),
            languageId: LEAN_LANGUAGE_ID,
            version,
            text,
          },
        });
      }
    });

    /**
     * Wait until diagnostics have arrived and none followed for a quiet window,
     * giving up silently after the overall diagnostics wait.
     */
    const waitForDiagnosticsQuiet = Effect.fn(
      'LeanServer.waitForDiagnosticsQuiet',
    )(
      function* (absolute: string) {
        const state = openFiles.get(absolute);
        if (!state) return;
        for (;;) {
          if (openFiles.get(absolute) !== state) {
            return yield* new LeanSessionDisposed();
          }
          const now = yield* clock.currentTimeMillis;
          if (
            state.lastDiagnosticsAt &&
            now - state.lastDiagnosticsAt >= DIAGNOSTICS_QUIET_WINDOW_MS
          ) {
            return;
          }
          yield* Deferred.await(state.next).pipe(
            Effect.timeoutOption(Duration.millis(DIAGNOSTICS_QUIET_WINDOW_MS)),
          );
        }
      },
      Effect.timeoutOrElse({
        duration: DIAGNOSTICS_WAIT,
        orElse: () => Effect.void,
      }),
    );

    const openAndSettle = Effect.fn('LeanServer.openAndSettle')(function* (
      filePath: string,
    ) {
      const absolute = path.resolve(filePath);
      yield* ensureFileOpen(absolute, false);
      yield* waitForDiagnosticsQuiet(absolute);
      return absolute;
    });

    const diagnostics = Effect.fn('LeanServer.diagnostics')(function* (
      filePath: string,
    ) {
      const absolute = yield* openAndSettle(filePath);
      const state = openFiles.get(absolute);
      if (!state) return yield* new LeanSessionDisposed();
      return state.diagnostics;
    });

    const requestSettled = Effect.fn('LeanServer.requestSettled')(function* <T>(
      filePath: string,
      line: number,
      column: number,
      method: string,
    ) {
      const absolute = yield* openAndSettle(filePath);
      const live = yield* requireRpc;
      return yield* live.request<T>(method, {
        textDocument: { uri: pathToUri(absolute) },
        position: { line, character: column },
      });
    });

    const restartFile = Effect.fn('LeanServer.restartFile')(function* (
      filePath: string,
    ) {
      const absolute = path.resolve(filePath);
      const live = yield* requireRpc;
      const state = openFiles.get(absolute);
      if (state) {
        yield* live.notify('textDocument/didClose', {
          textDocument: { uri: pathToUri(absolute) },
        });
        yield* Deferred.fail(state.next, new LeanSessionDisposed());
        openFiles.delete(absolute);
      }
      yield* ensureFileOpen(absolute, true);
    });

    return LeanServer.of({
      workspaceRoot: root,
      closed,
      isRunning: Effect.map(Deferred.isDone(ended), (done) => !done),
      shutdown,
      diagnostics,
      requestSettled,
      restartFile,
    });
  }).pipe(Effect.withSpan('LeanServer.make'));

function toLeanDiagnostic(d: LspDiagnostic): LeanDiagnostic {
  return {
    // LSP `DiagnosticSeverity` (Error=1) matches the VS Code numeric severity
    // (Error=0) shifted by one — translate to keep formatting consistent with
    // the extension-mediated path. Default to Error if absent.
    severity: lspSeverityToVsCode(d.severity ?? 1),
    message: d.message,
    range: {
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
    source: d.source,
  };
}

function lspSeverityToVsCode(severity: number): DiagnosticSeverity {
  // VS Code: Error=0, Warning=1, Information=2, Hint=3
  // LSP:     Error=1, Warning=2, Information=3, Hint=4
  // LSP severities are 1-4 so the shift always lands in 0-3; the cast keeps
  // the mapping to the DiagnosticSeverity union without adding a clamp (an
  // unexpected out-of-range value is still dropped by SEVERITY_CONFIG's
  // numeric lookup downstream, exactly as before).
  return Math.max(0, severity - 1) as DiagnosticSeverity;
}

function pathToUri(absolute: string): string {
  return pathToFileURL(absolute).toString();
}

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch (err) {
    // Malformed or non-local file URIs from an external Lean LSP server
    // (e.g. `file://host/path`, bad percent-encoding) make fileURLToPath
    // throw. This runs on the JSON-RPC notification path, so map to null
    // (an untracked URI the caller skips) rather than letting the exception
    // escape and break diagnostics handling.
    debug(LOG_CHANNEL, `Ignoring unmappable file URI ${uri}`, { data: err });
    return null;
  }
}
