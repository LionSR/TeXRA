/**
 * One Lean LSP session per workspace root.
 *
 * Spawns `lake env lean --server` from the project root, completes the
 * `initialize` handshake, and handles `textDocument/didOpen` lazily on the
 * first request that touches a file. Diagnostics arrive asynchronously via
 * `textDocument/publishDiagnostics` and are buffered per file.
 *
 * The server is one fiber forked into the session's scope: its child process
 * and JSON-RPC connection are scoped resources released when the server
 * exits, when its start fails, or when {@link LeanSession.close} closes the
 * scope. Callers await a startup `Deferred`, so a caller's interruption never
 * cancels a start another caller shares. Every wait is on the runtime clock:
 * the handshake, the graceful shutdown, the process-close escalation, and the
 * diagnostics quiet window.
 *
 * Lives under `src/tools/lean/direct/` (host-neutral): Node-only, no `vscode`
 * imports, suitable for both the CLI and the desktop main process.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Result,
  Scope,
} from 'effect';

import { debug, info, warn } from '@logger/logUtils';
import { effectRuntime } from '@platform/processRuntime';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { DiagnosticSeverity } from '@utils/diagnostics/diagnosticFormatting';
import {
  registerLeanServer,
  unregisterLeanServer,
  updateLeanServer,
} from '../leanServerRegistry';
import {
  JsonRpcConnection,
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

/** The session was disposed, or the file state a wait was pinned to is gone. */
export class LeanSessionDisposed extends Data.TaggedError(
  'LeanSessionDisposed',
) {
  override readonly message = 'Lean session has been disposed.';
}

/** No live server: never started, already exited, or disposed. */
export class LeanSessionNotRunning extends Data.TaggedError(
  'LeanSessionNotRunning',
) {
  override readonly message = 'Lean session is not running';
}

/** The server could not be spawned or did not complete `initialize`. */
export class LeanStartError extends Data.TaggedError('LeanStartError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The file to open could not be read from disk. */
export class LeanFileReadError extends Data.TaggedError('LeanFileReadError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type LeanSessionError =
  | LeanSessionDisposed
  | LeanSessionNotRunning
  | LeanStartError
  | LeanFileReadError
  | JsonRpcRequestError
  | JsonRpcConnectionDisposed;

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
  /** The child's `error`, when that is what ended it (EMFILE, ENOENT, ...). */
  readonly cause?: unknown;
}

interface SpawnedServer {
  readonly child: ChildProcessWithoutNullStreams;
  /** Settles on the child's `close` event, once its stdio has drained. */
  readonly closed: Deferred.Deferred<void>;
  /**
   * False when Node could not spawn the process at all (EMFILE/ENFILE): the
   * child then has no stdio streams and reports the cause on `error`.
   */
  readonly hasStdio: boolean;
}

interface LeanSessionOptions {
  workspaceRoot: string;
  lakeCommand: string;
  onExit?: () => Effect.Effect<void>;
}

function isAlive(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode == null && child.signalCode == null;
}

/**
 * Spawn the server and attach its listeners in one synchronous block: Node
 * delivers spawn failures (EMFILE, ENFILE, ENOENT, ...) through the child's
 * `error` event on the next tick, so the listener that records the cause
 * must exist before the fiber can yield. `settle` records how the server
 * ended; the first end wins.
 */
const spawnServer = Effect.fn('LeanSession.spawnServer')(function* (
  lakeCommand: string,
  root: string,
  settle: (ended: ServerEnd) => void,
) {
  return yield* Effect.try({
    try: (): SpawnedServer => {
      const child = spawn(lakeCommand, ['env', 'lean', '--server'], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Force POSIX behavior on Windows-Node by relying on lake's resolver.
        windowsHide: true,
      });
      const closed = Deferred.makeUnsafe<void>();
      child.once('close', () => Deferred.doneUnsafe(closed, Effect.void));
      child.once('error', (error) => {
        settle({
          status: 'error',
          message: `Failed to spawn 'lake env lean --server': ${toErrorMessage(error)}`,
          cause: error,
        });
      });
      // The stream types promise pipes, but a child Node failed to spawn
      // (EMFILE/ENFILE) comes back without them.
      const streams = child as Partial<ChildProcessWithoutNullStreams>;
      const hasStdio =
        streams.stdin != null &&
        streams.stdout != null &&
        streams.stderr != null;
      let stderrTail = '';
      if (hasStdio) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
          warn(LOG_CHANNEL, `[${root}] ${chunk.trimEnd()}`);
        });
      }
      child.on('exit', (code, signal) => {
        const tail = stderrTail.slice(-1000);
        info(
          LOG_CHANNEL,
          `lake env lean --server exited (code=${code}, signal=${signal}) at ${root}${tail ? `\n${tail}` : ''}`,
        );
        settle(
          code === 0
            ? { status: 'stopped' }
            : {
                status: 'error',
                message: `Server exited with code ${code}`,
              },
        );
      });
      return { child, closed, hasStdio };
    },
    catch: (error) =>
      new LeanStartError({
        message: `Failed to spawn 'lake env lean --server': ${toErrorMessage(error)}`,
        cause: error,
      }),
  });
});

/** Terminate the server and wait for its stdio to close, escalating to SIGKILL. */
const stopProcess = Effect.fn('LeanSession.stopProcess')(function* ({
  child,
  closed,
}: SpawnedServer) {
  if (isAlive(child)) child.kill();
  yield* Deferred.await(closed).pipe(
    Effect.timeoutOrElse({
      duration: SHUTDOWN_TIMEOUT,
      orElse: () =>
        Effect.suspend(() => {
          if (isAlive(child)) child.kill('SIGKILL');
          return Deferred.await(closed).pipe(
            Effect.timeoutOption(SHUTDOWN_TIMEOUT),
          );
        }),
    }),
  );
});

export class LeanSession {
  private readonly id: string;
  private readonly scope = Scope.makeUnsafe();
  private rpc?: JsonRpcConnection;
  private startup?: Deferred.Deferred<
    void,
    LeanStartError | LeanSessionDisposed
  >;
  private disposed = false;
  private readonly openFiles = new Map<string, OpenedFile>();

  constructor(private readonly options: LeanSessionOptions) {
    this.id = `direct:${options.workspaceRoot}`;
  }

  get workspaceRoot(): string {
    return this.options.workspaceRoot;
  }

  /** Start (or reuse) the server and complete `initialize`. Idempotent. */
  ensureReady(): Promise<void> {
    return effectRuntime().runPromise(this.ready());
  }

  /** Tear down the server and clear cached file state. */
  dispose(): Promise<void> {
    return effectRuntime().runPromise(this.close());
  }

  fetchDiagnostics(filePath: string): Promise<LeanDiagnostic[]> {
    return effectRuntime().runPromise(this.diagnostics(filePath));
  }

  /** Start the server unless one is starting or running, then await `initialize`. */
  ready(): Effect.Effect<void, LeanSessionDisposed | LeanStartError> {
    return Effect.gen({ self: this }, function* () {
      if (this.disposed) return yield* new LeanSessionDisposed();
      if (!this.startup) {
        const startup = Deferred.makeUnsafe<
          void,
          LeanStartError | LeanSessionDisposed
        >();
        this.startup = startup;
        yield* Effect.forkIn(this.serve(startup), this.scope);
      }
      yield* Deferred.await(this.startup);
    }).pipe(Effect.withSpan('LeanSession.ready'));
  }

  /**
   * Stop the server and release everything the session holds. Runs to
   * completion once begun: a graceful `shutdown`/`exit` bounded by the
   * shutdown timeout, then the scope close that kills the process and waits
   * for its stdio to drain.
   */
  close(): Effect.Effect<void> {
    return Effect.uninterruptible(
      Effect.gen({ self: this }, function* () {
        if (this.disposed) return;
        this.disposed = true;
        unregisterLeanServer(this.id);
        if (this.startup) {
          Deferred.doneUnsafe(
            this.startup,
            Effect.fail(new LeanSessionDisposed()),
          );
        }
        this.abandonFiles();
        const rpc = this.rpc;
        if (rpc) {
          yield* rpc.request('shutdown').pipe(
            Effect.timeoutOrElse({
              duration: SHUTDOWN_TIMEOUT,
              orElse: () =>
                Effect.sync(() =>
                  debug(
                    LOG_CHANNEL,
                    `[${this.workspaceRoot}] shutdown request timed out after ${Duration.toMillis(SHUTDOWN_TIMEOUT)}ms`,
                  ),
                ),
            }),
            Effect.catch((error) =>
              Effect.sync(() =>
                debug(
                  LOG_CHANNEL,
                  `[${this.workspaceRoot}] shutdown request failed: ${toErrorMessage(error)}`,
                ),
              ),
            ),
          );
          yield* rpc.notify('exit');
        }
        yield* Scope.close(this.scope, Exit.void);
      }),
    ).pipe(Effect.withSpan('LeanSession.close'));
  }

  diagnostics(
    filePath: string,
  ): Effect.Effect<LeanDiagnostic[], LeanSessionError> {
    return Effect.gen({ self: this }, function* () {
      const absolute = yield* this.openAndSettle(filePath);
      const diagnostics = this.openFiles.get(absolute)?.diagnostics;
      if (this.disposed || diagnostics == null) {
        return yield* new LeanSessionDisposed();
      }
      return diagnostics;
    }).pipe(Effect.withSpan('LeanSession.diagnostics'));
  }

  restartFile(filePath: string): Effect.Effect<void, LeanSessionError> {
    return Effect.gen({ self: this }, function* () {
      const absolute = path.resolve(filePath);
      const rpc = this.rpc;
      if (!rpc) return;
      const state = this.openFiles.get(absolute);
      if (state) {
        yield* rpc.notify('textDocument/didClose', {
          textDocument: { uri: pathToUri(absolute) },
        });
        Deferred.doneUnsafe(state.next, Effect.fail(new LeanSessionDisposed()));
        this.openFiles.delete(absolute);
      }
      yield* this.ensureFileOpen(absolute, true);
    }).pipe(Effect.withSpan('LeanSession.restartFile'));
  }

  /**
   * Open the file (if needed), wait for Lean's diagnostics to settle, and
   * send a position-scoped LSP request. Position requests like
   * `$/lean/plainGoal` return stale data if the elaborator hasn't finished —
   * the quiet-window wait is the only way to get correct goal state.
   */
  requestSettled<T>(
    filePath: string,
    line: number,
    column: number,
    method: string,
  ): Effect.Effect<T, LeanSessionError> {
    return Effect.gen({ self: this }, function* () {
      const absolute = yield* this.openAndSettle(filePath);
      const rpc = yield* this.requireRpc();
      return yield* rpc.request<T>(method, {
        textDocument: { uri: pathToUri(absolute) },
        position: { line, character: column },
      });
    }).pipe(Effect.withSpan('LeanSession.requestSettled'));
  }

  /** The live JSON-RPC connection, or `LeanSessionNotRunning`. */
  private requireRpc(): Effect.Effect<
    JsonRpcConnection,
    LeanSessionNotRunning
  > {
    return Effect.suspend(() =>
      this.disposed || !this.rpc
        ? Effect.fail(new LeanSessionNotRunning())
        : Effect.succeed(this.rpc),
    );
  }

  private openAndSettle(
    filePath: string,
  ): Effect.Effect<string, LeanSessionError> {
    return Effect.gen({ self: this }, function* () {
      const absolute = path.resolve(filePath);
      yield* this.ready();
      yield* this.ensureFileOpen(absolute, false);
      yield* this.waitForDiagnosticsQuiet(absolute);
      return absolute;
    }).pipe(Effect.withSpan('LeanSession.openAndSettle'));
  }

  /**
   * The server's lifetime as one fiber: spawn, handshake, then wait for the
   * process to exit. Its process and connection are scoped to the fiber, so
   * they are released whether the start fails, the server exits on its own,
   * or `close()` interrupts the fiber. `startup` settles when `initialize`
   * completes or fails; `close()` fails it first when it interrupts a start.
   */
  private serve(
    startup: Deferred.Deferred<void, LeanStartError | LeanSessionDisposed>,
  ): Effect.Effect<void> {
    const root = this.options.workspaceRoot;
    let end: ServerEnd | undefined;
    return Effect.gen({ self: this }, function* () {
      registerLeanServer({
        id: this.id,
        workspaceRoot: root,
        mode: 'direct-lsp',
        status: 'starting',
      });
      const clock = yield* Clock.clockWith(Effect.succeed);
      const exited = Deferred.makeUnsafe<ServerEnd>();
      const settle = (ended: ServerEnd): void => {
        end ??= ended;
        Deferred.doneUnsafe(exited, Effect.succeed(ended));
      };
      // The server ended before `initialize` completed. The cause is kept:
      // the adapter's file-table retry matches EMFILE/ENFILE on it.
      const endedBeforeReady = Deferred.await(exited).pipe(
        Effect.flatMap((ended) =>
          Effect.fail(
            new LeanStartError({
              message: ended.message ?? 'Lean server stopped',
              cause: ended.cause,
            }),
          ),
        ),
      );

      const started = yield* Effect.result(
        Effect.gen({ self: this }, function* () {
          const { child, hasStdio } = yield* Effect.acquireRelease(
            spawnServer(this.options.lakeCommand, root, settle),
            stopProcess,
          );
          if (!hasStdio) return yield* endedBeforeReady;

          const rpc = yield* Effect.acquireRelease(
            Effect.sync(() => new JsonRpcConnection(child.stdin, child.stdout)),
            (rpc) =>
              Effect.sync(() => {
                rpc.dispose(
                  end
                    ? (end.message ?? 'Lean server stopped')
                    : 'LeanSession.dispose',
                );
              }),
          );
          rpc.onNotification('textDocument/publishDiagnostics', (params) =>
            this.handlePublishDiagnostics(
              params as LspPublishDiagnosticsParams,
              clock.currentTimeMillisUnsafe(),
            ),
          );
          rpc.onNotification('window/logMessage', (params) => {
            debug(LOG_CHANNEL, `[${root}] ${JSON.stringify(params)}`);
          });
          rpc.onNotification('window/showMessage', (params) => {
            info(LOG_CHANNEL, `[${root}] ${JSON.stringify(params)}`);
          });

          yield* rpc
            .request('initialize', {
              processId: process.pid,
              clientInfo: { name: 'texra-direct-lsp' },
              rootUri: pathToUri(root),
              workspaceFolders: [
                { uri: pathToUri(root), name: path.basename(root) },
              ],
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
                    new LeanStartError({
                      message: 'Lean LSP initialize timeout',
                    }),
                  ),
              }),
              Effect.catchTag(
                ['JsonRpcRequestError', 'JsonRpcConnectionDisposed'],
                (error) =>
                  Effect.fail(
                    new LeanStartError({
                      message: error.message,
                      cause: error,
                    }),
                  ),
              ),
            );
          yield* rpc.notify('initialized', {});
          return rpc;
        }),
      );

      if (Result.isFailure(started)) {
        end ??= { status: 'error', message: started.failure.message };
        Deferred.doneUnsafe(startup, Effect.fail(started.failure));
        return;
      }
      this.rpc = started.success;
      updateLeanServer(this.id, { status: 'running' });
      Deferred.doneUnsafe(startup, Effect.void);
      yield* Deferred.await(exited);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.suspend(() => this.finalize(end ?? { status: 'stopped' })),
      ),
      Effect.withSpan('LeanSession.serve'),
    );
  }

  /** The server is gone: drop its state, record its end, tell the owner. */
  private finalize(end: ServerEnd): Effect.Effect<void> {
    return Effect.suspend(() => {
      updateLeanServer(this.id, {
        status: end.status,
        errorMessage: end.message,
      });
      this.rpc = undefined;
      this.startup = undefined;
      this.abandonFiles();
      return this.options.onExit?.() ?? Effect.void;
    });
  }

  private ensureFileOpen(
    absolute: string,
    forceReload: boolean,
  ): Effect.Effect<void, LeanSessionNotRunning | LeanFileReadError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.requireRpc();
      if (this.openFiles.has(absolute) && !forceReload) return;
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
      const existing = this.openFiles.get(absolute);
      if (existing && !forceReload) return;
      // Re-check after the read: the session may have been disposed meanwhile.
      const rpc = yield* this.requireRpc();
      const version = (existing?.version ?? 0) + 1;
      if (existing) {
        existing.version = version;
        existing.diagnostics = [];
        existing.lastDiagnosticsAt = 0;
        yield* rpc.notify('textDocument/didChange', {
          textDocument: { uri: pathToUri(absolute), version },
          contentChanges: [{ text }],
        });
      } else {
        this.openFiles.set(absolute, {
          version,
          diagnostics: [],
          lastDiagnosticsAt: 0,
          next: Deferred.makeUnsafe(),
        });
        yield* rpc.notify('textDocument/didOpen', {
          textDocument: {
            uri: pathToUri(absolute),
            languageId: LEAN_LANGUAGE_ID,
            version,
            text,
          },
        });
      }
    }).pipe(Effect.withSpan('LeanSession.ensureFileOpen'));
  }

  /**
   * Wait until diagnostics have arrived and none followed for a quiet window,
   * giving up silently after the overall diagnostics wait.
   */
  private waitForDiagnosticsQuiet(
    absolute: string,
  ): Effect.Effect<void, LeanSessionDisposed> {
    const state = this.openFiles.get(absolute);
    if (!state) return Effect.void;
    return Effect.gen({ self: this }, function* () {
      for (;;) {
        if (this.disposed || this.openFiles.get(absolute) !== state) {
          return yield* new LeanSessionDisposed();
        }
        const now = yield* Clock.currentTimeMillis;
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
    }).pipe(
      Effect.timeoutOrElse({
        duration: DIAGNOSTICS_WAIT,
        orElse: () => Effect.void,
      }),
      Effect.withSpan('LeanSession.waitForDiagnosticsQuiet'),
    );
  }

  private handlePublishDiagnostics(
    params: LspPublishDiagnosticsParams,
    now: number,
  ): void {
    const absolute = fileUriToPath(params.uri);
    if (!absolute) return;
    const state = this.openFiles.get(absolute);
    if (!state) return;
    state.diagnostics = params.diagnostics.map(toLeanDiagnostic);
    state.lastDiagnosticsAt = now;
    // Wake the quiet-window waiters; each re-arms on the fresh deferred.
    const arrived = state.next;
    state.next = Deferred.makeUnsafe();
    Deferred.doneUnsafe(arrived, Effect.void);
  }

  /** Fail every pending diagnostics wait and forget the open files. */
  private abandonFiles(): void {
    for (const state of this.openFiles.values()) {
      Deferred.doneUnsafe(state.next, Effect.fail(new LeanSessionDisposed()));
    }
    this.openFiles.clear();
  }
}

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

export function fileUriToPath(uri: string): string | null {
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
