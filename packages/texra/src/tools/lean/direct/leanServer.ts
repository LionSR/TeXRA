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
 * kept in the file's state; Lean's `$/lean/fileProgress` says when the
 * file's current version is elaborated, which diagnostics and position
 * requests wait for first.
 *
 * Release is the scope's finalizers, in order: the shutdown protocol
 * (`shutdown` request under its bound, `exit`, SIGTERM, wait, SIGKILL, wait),
 * the JSON-RPC close, the process stop (a no-op once the protocol ran).
 * Every wait is on the runtime clock.
 *
 * Lives under `packages/texra/src/tools/lean/direct/` (host-neutral): Node-only, no `vscode`
 * imports, suitable for both the CLI and the desktop main process.
 */

import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Result,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { ChildProcess, type ChildProcessSpawner } from 'effect/process';

import { toErrorMessage } from '@texra-ai/harness/schemas';
import {
  connectJsonRpcProcess,
  type JsonRpcConnectionDisposed,
  type JsonRpcRequestError,
  withLogChannel,
  type PerKeyLane,
  withPerKeyLane,
} from '@texra-ai/harness/plugins';
import type { DiagnosticSeverity } from '@texra/utils/diagnostics/diagnosticFormatting';
import type { LeanServerInfo } from '../leanServerInfo';
import {
  LeanFileUnreadable,
  LspRangeSchema,
  type LeanDiagnostic,
} from '../leanTypes';

const LOG_CHANNEL = 'lean.direct';

const LspDiagnosticSchema = Schema.Struct({
  range: LspRangeSchema,
  message: Schema.String,
  severity: Schema.optional(Schema.Finite),
  source: Schema.optional(Schema.String),
});
type LspDiagnostic = typeof LspDiagnosticSchema.Type;

/** `textDocument/publishDiagnostics` as the server sends it. */
const LspPublishDiagnosticsSchema = Schema.Struct({
  uri: Schema.String,
  diagnostics: Schema.Array(LspDiagnosticSchema),
});
type LspPublishDiagnosticsParams = typeof LspPublishDiagnosticsSchema.Type;
const decodePublishDiagnostics = Schema.decodeUnknownResult(
  LspPublishDiagnosticsSchema,
);

/**
 * Lean's `$/lean/fileProgress` notification: the ranges of the document
 * version still being elaborated. `kind` 1 (or absent) is processing, 2 a
 * fatal error that will not finish; nothing processing means elaborated.
 */
const LeanFileProgressSchema = Schema.Struct({
  textDocument: Schema.Struct({ uri: Schema.String, version: Schema.Finite }),
  processing: Schema.Array(
    Schema.Struct({
      range: LspRangeSchema,
      kind: Schema.optional(Schema.Finite),
    }),
  ),
});
type LeanFileProgressParams = typeof LeanFileProgressSchema.Type;
const decodeFileProgress = Schema.decodeUnknownResult(LeanFileProgressSchema);

const LEAN_LANGUAGE_ID = 'lean4';
const HANDSHAKE_TIMEOUT = Duration.millis(15_000);
const SHUTDOWN_TIMEOUT = Duration.millis(2_000);
const DIAGNOSTICS_WAIT = Duration.millis(10_000);
const DIAGNOSTICS_QUIET_WINDOW = Duration.millis(400);
const STDERR_TAIL_LIMIT = 4096;

/** No live server: already exited, or shut down. */
class LeanSessionNotRunning extends Schema.TaggedError<LeanSessionNotRunning>()(
  'LeanSessionNotRunning',
  {},
) {
  override readonly message = 'Lean session is not running';
}

/** The server could not be spawned or did not complete `initialize`. */
export class LeanStartError extends Schema.TaggedError<LeanStartError>()(
  'LeanStartError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

type LeanSessionError =
  | LeanSessionNotRunning
  | LeanFileUnreadable
  | JsonRpcRequestError
  | JsonRpcConnectionDisposed;

interface LeanServerOptions {
  readonly workspaceRoot: string;
}

export class LeanServer extends Context.Service<
  LeanServer,
  {
    /** The server's line on the Tools dashboard. */
    readonly info: Effect.Effect<LeanServerInfo>;
    /**
     * Run the shutdown protocol now, ahead of the scope's release (which
     * then finds nothing left to do). Idempotent; concurrent callers join.
     */
    readonly shutdown: Effect.Effect<void>;
    /**
     * Open the file (if needed) and wait for Lean to elaborate it. `complete`
     * is false when the wait ended first: the diagnostics are those so far.
     */
    readonly diagnostics: (filePath: string) => Effect.Effect<
      {
        readonly diagnostics: LeanDiagnostic[];
        readonly complete: boolean;
        /** The text Lean was sent for the version these describe. */
        readonly text: string;
      },
      LeanSessionError
    >;
    /**
     * Open the file (if needed), wait for Lean to elaborate it, and send a
     * position-scoped LSP request. Position requests like `$/lean/plainGoal`
     * return stale data if the elaborator hasn't finished.
     */
    readonly requestElaborated: (
      filePath: string,
      line: number,
      column: number,
      method: string,
    ) => Effect.Effect<unknown, LeanSessionError>;
    /** Drop the cached open state and re-open with fresh contents. */
    readonly restartFile: (
      filePath: string,
    ) => Effect.Effect<void, LeanSessionError>;
  }
>()('@texra-ai/texra/tools/LeanServer') {
  static readonly layer = (
    options: LeanServerOptions,
  ): Layer.Layer<
    LeanServer,
    LeanStartError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  > => Layer.effect(LeanServer)(make(options));
}

/** What Lean has said about the open version of a file. */
interface FileState {
  readonly version: number;
  /** The file's text as this version was opened with it. */
  readonly text: string;
  /** Absent until Lean publishes diagnostics for this version. */
  readonly diagnostics?: LeanDiagnostic[];
  /** Lean's last `$/lean/fileProgress` for this version, if it sent one. */
  readonly progress: 'unreported' | 'processing' | 'elaborated';
}

interface ServerEnd {
  readonly status: 'stopped' | 'error';
  readonly message?: string;
  /** The errno the exit carried, when that is what ended it. */
  readonly cause?: unknown;
}

function spawnFailure(error: PlatformError.PlatformError): LeanStartError {
  return new LeanStartError({
    message: `Failed to spawn 'lake env lean --server': ${toErrorMessage(error)}`,
    cause: error,
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
  // A spawn errno (ENOENT, EMFILE, ...) never reaches here: the spawner
  // fails the spawn itself, so `spawnFailure` reports it at the start below.
  const { reason } = result.failure;
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
        Effect.logDebug(`kill failed: ${error.message}`).pipe(
          withLogChannel(LOG_CHANNEL),
        ),
      ),
    );
  // Only the wait matters: a server ended by the signal just sent has no exit
  // code, which fails the read.
  yield* Effect.ignore(handle.exitCode).pipe(
    Effect.timeoutOption(SHUTDOWN_TIMEOUT),
  );
});

const make = ({
  workspaceRoot: root,
}: LeanServerOptions): Effect.Effect<
  LeanServer['Service'],
  LeanStartError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const startedAt = yield* Clock.currentTimeMillis;
    const openFiles = new Map<
      string,
      SubscriptionRef.SubscriptionRef<FileState>
    >();

    const handle = yield* ChildProcess.make('lake', [
      'env',
      'lean',
      '--server',
    ]).pipe(ChildProcess.setCwd(root), Effect.mapError(spawnFailure));
    yield* Effect.addFinalizer(() => stopProcess(handle));

    const handlePublishDiagnostics = Effect.fn('handlePublishDiagnostics')(
      function* (params: LspPublishDiagnosticsParams) {
        const absolute = yield* fileUriToPath(params.uri);
        const file = absolute && openFiles.get(absolute);
        if (!file) return;
        const diagnostics = params.diagnostics.map(toLeanDiagnostic);
        yield* SubscriptionRef.update(file, (state) => ({
          ...state,
          diagnostics,
        }));
      },
    );

    const handleFileProgress = Effect.fn('handleFileProgress')(function* (
      params: LeanFileProgressParams,
    ) {
      const absolute = yield* fileUriToPath(params.textDocument.uri);
      const file = absolute && openFiles.get(absolute);
      if (!file) return;
      const progress: FileState['progress'] = params.processing.some(
        (range) => (range.kind ?? 1) === 1,
      )
        ? 'processing'
        : 'elaborated';
      yield* SubscriptionRef.update(file, (state) =>
        // A report on a version since replaced says nothing about this one.
        state.version === params.textDocument.version
          ? { ...state, progress }
          : state,
      );
    });

    /** A notification the server sent in a shape LSP does not define. */
    const ignoreMalformed = (method: string, error: Schema.SchemaError) =>
      Effect.logWarning(
        `[${root}] Ignored a malformed ${method} notification: ${error.message}`,
      ).pipe(withLogChannel(LOG_CHANNEL));

    // The connection closes with the server's end as its reason once the
    // server is gone, and `exited` holds that end from then on.
    const { connection: rpc, exited } = yield* connectJsonRpcProcess(handle, {
      stderrTailLimit: STDERR_TAIL_LIMIT,
      onStderr: (text) =>
        Effect.logWarning(`[${root}] ${text.trimEnd()}`).pipe(
          withLogChannel(LOG_CHANNEL),
        ),
      drainTimeout: SHUTDOWN_TIMEOUT,
      end: Effect.fnUntraced(function* (exit, tail) {
        const end = describeEnd(exit);
        yield* Effect.logInfo(
          `lake env lean --server ended (${end.message ?? 'exit code 0'}) at ${root}${tail ? `\n${tail}` : ''}`,
        ).pipe(withLogChannel(LOG_CHANNEL));
        return end.message ?? 'Lean server stopped';
      }),
      onNotification: (method, params) => {
        switch (method) {
          case 'textDocument/publishDiagnostics': {
            const decoded = decodePublishDiagnostics(params);
            return Result.isSuccess(decoded)
              ? handlePublishDiagnostics(decoded.success)
              : ignoreMalformed(method, decoded.failure);
          }
          case '$/lean/fileProgress': {
            const decoded = decodeFileProgress(params);
            return Result.isSuccess(decoded)
              ? handleFileProgress(decoded.success)
              : ignoreMalformed(method, decoded.failure);
          }
          case 'window/logMessage':
            return Effect.logDebug(`[${root}] ${JSON.stringify(params)}`).pipe(
              withLogChannel(LOG_CHANNEL),
            );
          case 'window/showMessage':
            return Effect.logInfo(`[${root}] ${JSON.stringify(params)}`).pipe(
              withLogChannel(LOG_CHANNEL),
            );
          default:
            return Effect.void;
        }
      },
    });

    const ended = Effect.map(Deferred.await(exited), describeEnd);
    // The server ended before `initialize` completed. The cause is kept: the
    // pool's file-table retry matches EMFILE/ENFILE on it.
    const endedBeforeReady = ended.pipe(
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

    const shutdown = yield* Effect.cached(
      Effect.gen(function* () {
        yield* Effect.logInfo(`Stopping Lean server at ${root}`).pipe(
          withLogChannel(LOG_CHANNEL),
        );
        yield* rpc.request('shutdown').pipe(
          Effect.timeoutOrElse({
            duration: SHUTDOWN_TIMEOUT,
            orElse: () =>
              Effect.logDebug(
                `[${root}] shutdown request timed out after ${Duration.toMillis(SHUTDOWN_TIMEOUT)}ms`,
              ).pipe(withLogChannel(LOG_CHANNEL)),
          }),
          Effect.catch((error) =>
            Effect.logDebug(
              `[${root}] shutdown request failed: ${toErrorMessage(error)}`,
            ).pipe(withLogChannel(LOG_CHANNEL)),
          ),
        );
        yield* rpc.notify('exit');
        yield* stopProcess(handle);
        // The end watcher closes the connection with the exit as its reason;
        // wait for it so a caller sees the server fully ended, bounded like
        // every other step of the protocol.
        yield* Effect.timeoutOption(ended, SHUTDOWN_TIMEOUT);
      }).pipe(Effect.uninterruptible, Effect.withSpan('LeanServer.shutdown')),
    );
    yield* Effect.addFinalizer(() => shutdown);

    /** The live connection, or `LeanSessionNotRunning`. */
    const requireRpc = Effect.gen(function* () {
      if (yield* Deferred.isDone(exited)) {
        return yield* new LeanSessionNotRunning();
      }
      return rpc;
    });

    /**
     * One writer per file for `openFiles` and the server's document stream.
     * Every run on this Lake root shares the server, so two of them opening
     * or restarting one file at once would both read it and both send
     * `didOpen` at the same version.
     */
    const fileLanes = new Map<string, PerKeyLane>();
    const onFileLane = (absolute: string) =>
      withPerKeyLane(fileLanes, absolute);

    /**
     * Read the file and send `didOpen`: at version 1, or, reopening a file
     * this server closed, one past its last version, so a progress report on
     * the old version is not read as the new one's. Entered on the file's
     * lane.
     */
    const openFile = Effect.fn('LeanServer.openFile')(function* (
      absolute: string,
    ) {
      yield* requireRpc;
      // The process FileSystem is unrooted: it reads the bytes lean sees.
      const text = yield* fs.readFileString(absolute).pipe(
        Effect.mapError(
          (cause) =>
            new LeanFileUnreadable({
              message: `Failed to read ${absolute}: ${cause.message}`,
              cause,
            }),
        ),
      );
      // Re-check after the read: the server may have ended meanwhile.
      const live = yield* requireRpc;
      const reopened = openFiles.get(absolute);
      const version = reopened
        ? (yield* SubscriptionRef.get(reopened)).version + 1
        : 1;
      const state: FileState = { version, text, progress: 'unreported' };
      const file = reopened ?? (yield* SubscriptionRef.make(state));
      if (reopened) yield* SubscriptionRef.set(reopened, state);
      else openFiles.set(absolute, file);
      yield* live.notify('textDocument/didOpen', {
        textDocument: {
          uri: pathToUri(absolute),
          languageId: LEAN_LANGUAGE_ID,
          version,
          text,
        },
      });
      return file;
    });

    const ensureFileOpen = (absolute: string) =>
      Effect.suspend(() => {
        const file = openFiles.get(absolute);
        return file ? Effect.succeed(file) : openFile(absolute);
      }).pipe(onFileLane(absolute));

    /** Fails with `LeanSessionNotRunning` once the server has ended. */
    const serverEnded = ended.pipe(
      Effect.andThen(Effect.fail(new LeanSessionNotRunning())),
    );

    /**
     * Wait until Lean reports the file's current version elaborated, and say
     * whether it did. A server that has reported no progress for the version
     * finishes once its diagnostics have been quiet for a window instead, and
     * the overall wait bounds both; either of those ends the wait
     * unelaborated (`false`). A reopen sets the state to the new version, so
     * a wait already running waits for that one.
     */
    const waitForElaboration = (
      file: SubscriptionRef.SubscriptionRef<FileState>,
    ) => {
      const elaborated = SubscriptionRef.changes(file).pipe(
        Stream.filter((state) => state.progress === 'elaborated'),
        Stream.take(1),
        Stream.runDrain,
        Effect.as(true),
      );
      const quiet = SubscriptionRef.changes(file).pipe(
        Stream.debounce(DIAGNOSTICS_QUIET_WINDOW),
        Stream.filter(
          (state) =>
            state.progress === 'unreported' && state.diagnostics !== undefined,
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.as(false),
      );
      return Effect.race(elaborated, quiet).pipe(
        Effect.raceFirst(serverEnded),
        Effect.timeoutOrElse({
          duration: DIAGNOSTICS_WAIT,
          orElse: () => Effect.succeed(false),
        }),
        Effect.withSpan('LeanServer.waitForElaboration'),
      );
    };

    const openElaborated = Effect.fn('LeanServer.openElaborated')(function* (
      filePath: string,
    ) {
      const absolute = path.resolve(filePath);
      const file = yield* ensureFileOpen(absolute);
      const complete = yield* waitForElaboration(file);
      return { absolute, file, complete };
    });

    const diagnostics = Effect.fn('LeanServer.diagnostics')(function* (
      filePath: string,
    ) {
      const { file, complete } = yield* openElaborated(filePath);
      const state = yield* SubscriptionRef.get(file);
      return {
        diagnostics: state.diagnostics ?? [],
        complete,
        text: state.text,
      };
    });

    const requestElaborated = Effect.fn('LeanServer.requestElaborated')(
      function* (
        filePath: string,
        line: number,
        column: number,
        method: string,
      ) {
        const { absolute } = yield* openElaborated(filePath);
        const live = yield* requireRpc;
        return yield* live.request(method, {
          textDocument: { uri: pathToUri(absolute) },
          position: { line, character: column },
        });
      },
    );

    const restartFile = Effect.fn('LeanServer.restartFile')(function* (
      filePath: string,
    ) {
      const absolute = path.resolve(filePath);
      yield* Effect.gen(function* () {
        const live = yield* requireRpc;
        if (openFiles.has(absolute)) {
          yield* live.notify('textDocument/didClose', {
            textDocument: { uri: pathToUri(absolute) },
          });
        }
        // A reopen that fails leaves the file closed at the server, so the
        // next request opens it afresh.
        yield* openFile(absolute).pipe(
          Effect.tapError(() => Effect.sync(() => openFiles.delete(absolute))),
        );
      }).pipe(onFileLane(absolute));
    });

    const base = { workspaceRoot: root };
    const info = Effect.flatMap(
      Deferred.poll(exited),
      (end): Effect.Effect<LeanServerInfo> =>
        Option.isNone(end)
          ? Effect.succeed({ ...base, status: 'running', startedAt })
          : Effect.map(end.value, (exit) => {
              const { status, message } = describeEnd(exit);
              return status === 'error'
                ? {
                    ...base,
                    status,
                    errorMessage: message ?? 'Lean server stopped',
                  }
                : { ...base, status };
            }),
    );

    return LeanServer.of({
      info,
      shutdown,
      diagnostics,
      requestElaborated,
      restartFile,
    });
  }).pipe(Effect.withSpan('LeanServer.make'));

function toLeanDiagnostic(d: LspDiagnostic): LeanDiagnostic {
  return {
    // LSP `DiagnosticSeverity` (Error=1) is the VS Code numeric severity
    // (Error=0) that `GenericDiagnostic` uses, shifted by one: translate so
    // Lean's diagnostics format as the LaTeX ones do. Default to Error if
    // absent.
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
  // No clamp: an out-of-range value reads as an unknown severity downstream
  // (SEVERITY_CONFIG's lookup), as it always has.
  // cast: LSP severities are 1-4, so the shift lands in 0-3.
  return Math.max(0, severity - 1) as DiagnosticSeverity;
}

function pathToUri(absolute: string): string {
  return pathToFileURL(absolute).toString();
}

function fileUriToPath(uri: string): Effect.Effect<string | null> {
  if (!uri.startsWith('file://')) return Effect.succeed(null);
  // Malformed or non-local file URIs from an external Lean LSP server
  // (e.g. `file://host/path`, bad percent-encoding) make fileURLToPath
  // throw. This runs on the JSON-RPC notification path, so map to null
  // (an untracked URI the caller skips) rather than letting the exception
  // escape and break diagnostics handling.
  return Effect.sync(() => fileURLToPath(uri)).pipe(
    Effect.catchDefect((defect) =>
      Effect.logDebug(`Ignoring unmappable file URI ${uri}`).pipe(
        withLogChannel(LOG_CHANNEL),
        Effect.annotateLogs({ data: defect }),
        Effect.as(null),
      ),
    ),
  );
}
