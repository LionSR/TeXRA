/**
 * One Lean LSP session per workspace root.
 *
 * Spawns `lake env lean --server` from the project root, completes the
 * `initialize` handshake, and handles `textDocument/didOpen` lazily on the
 * first request that touches a file. Diagnostics arrive asynchronously via
 * `textDocument/publishDiagnostics` and are buffered per file.
 *
 * Lives under `src/tools/lean/direct/` (host-neutral): Node-only, no `vscode`
 * imports, suitable for both the CLI and the desktop main process.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pTimeout from 'p-timeout';

import { debug, info, warn } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { DiagnosticSeverity } from '@utils/diagnostics/diagnosticFormatting';
import {
  registerLeanServer,
  unregisterLeanServer,
  updateLeanServer,
} from '../leanServerRegistry';
import { JsonRpcConnection } from './jsonRpc';
import type {
  LeanDiagnostic,
  LspDiagnostic,
  LspPublishDiagnosticsParams,
} from '../leanTypes';

const LOG_CHANNEL = 'lean.direct';

const LEAN_LANGUAGE_ID = 'lean4';
const HANDSHAKE_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const DIAGNOSTICS_WAIT_MS = 10_000;
const DIAGNOSTICS_QUIET_WINDOW_MS = 400;

interface OpenedFile {
  version: number;
  diagnostics: LeanDiagnostic[];
  lastDiagnosticsAt: number;
  // Resolved when diagnostics arrive after the next `didOpen`/`didChange`.
  diagnosticsWaiters: Array<{
    resolve: () => void;
    timeout: NodeJS.Timeout;
  }>;
}

export interface LeanSessionOptions {
  workspaceRoot: string;
  lakeCommand: string;
  onExit?: () => void;
}

export class LeanSession {
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: JsonRpcConnection;
  private readonly id: string;
  private readyPromise?: Promise<void>;
  private disposed = false;
  private readonly openFiles = new Map<string, OpenedFile>();

  constructor(private readonly options: LeanSessionOptions) {
    this.id = `direct:${options.workspaceRoot}`;
  }

  get workspaceRoot(): string {
    return this.options.workspaceRoot;
  }

  /** Start (or reuse) the server and complete `initialize`. Idempotent. */
  async ensureReady(): Promise<void> {
    if (this.disposed) {
      throw new Error('Lean session has been disposed.');
    }
    this.readyPromise ??= this.spawnAndInitialize();
    await this.readyPromise;
  }

  /** Tear down the server and clear cached file state. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    const rpc = this.rpc;
    this.child = undefined;
    this.rpc = undefined;
    this.readyPromise = undefined;
    this.releaseAllDiagnosticsWaiters();
    this.openFiles.clear();
    unregisterLeanServer(this.id);
    if (!rpc || !child) return;
    try {
      await pTimeout(rpc.request('shutdown'), {
        milliseconds: SHUTDOWN_TIMEOUT_MS,
        message: 'Lean LSP shutdown timeout',
      }).catch(() => undefined);
      rpc.notify('exit');
    } finally {
      rpc.dispose('LeanSession.dispose');
      if (!child.killed) {
        child.kill();
      }
    }
  }

  async fetchDiagnostics(filePath: string): Promise<LeanDiagnostic[]> {
    const absolute = await this.openAndSettle(filePath);
    return this.openFiles.get(absolute)?.diagnostics ?? [];
  }

  async restartFile(filePath: string): Promise<void> {
    const absolute = path.resolve(filePath);
    if (!this.rpc) return;
    const state = this.openFiles.get(absolute);
    if (state) {
      this.rpc.notify('textDocument/didClose', {
        textDocument: { uri: pathToUri(absolute) },
      });
      this.releaseDiagnosticsWaiters(state);
      this.openFiles.delete(absolute);
    }
    await this.ensureFileOpen(absolute, true);
  }

  /**
   * Open the file (if needed), wait for Lean's diagnostics to settle, and
   * send a position-scoped LSP request. Position requests like
   * `$/lean/plainGoal` return stale data if the elaborator hasn't finished —
   * the quiet-window wait is the only way to get correct goal state.
   */
  async requestSettled<T>(
    filePath: string,
    line: number,
    column: number,
    method: string,
  ): Promise<T> {
    const absolute = await this.openAndSettle(filePath);
    const params = {
      textDocument: { uri: pathToUri(absolute) },
      position: { line, character: column },
    };
    return this.requireRpc().request<T>(method, params);
  }

  /** Return the live JSON-RPC connection, or throw if the session is down. */
  private requireRpc(): JsonRpcConnection {
    if (this.disposed || !this.rpc) {
      throw new Error('Lean session is not running');
    }
    return this.rpc;
  }

  private async openAndSettle(filePath: string): Promise<string> {
    const absolute = path.resolve(filePath);
    await this.ensureReady();
    await this.ensureFileOpen(absolute, false);
    await this.waitForDiagnosticsQuiet(absolute);
    return absolute;
  }

  private async spawnAndInitialize(): Promise<void> {
    const root = this.options.workspaceRoot;
    const lake = this.options.lakeCommand;
    registerLeanServer({
      id: this.id,
      workspaceRoot: root,
      mode: 'direct-lsp',
      status: 'starting',
    });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(lake, ['env', 'lean', '--server'], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Force POSIX behavior on Windows-Node by relying on lake's resolver.
        windowsHide: true,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      updateLeanServer(this.id, { status: 'error', errorMessage: message });
      throw new Error(`Failed to spawn 'lake env lean --server': ${message}`, {
        cause: error,
      });
    }
    this.child = child;
    let stderrTail = '';
    const STDERR_TAIL_LIMIT = 4096;
    let finalized = false;
    const finalizeServer = (status: 'stopped' | 'error', message?: string) => {
      if (finalized) return;
      finalized = true;
      this.options.onExit?.();
      updateLeanServer(this.id, { status, errorMessage: message });
      this.child = undefined;
      this.rpc?.dispose(message ?? 'Lean server stopped');
      this.rpc = undefined;
      this.readyPromise = undefined;
      this.releaseAllDiagnosticsWaiters();
      this.openFiles.clear();
    };
    const childError = new Promise<never>((_resolve, reject) => {
      child.once('error', (error) => {
        const message = toErrorMessage(error);
        finalizeServer('error', message);
        reject(
          new Error(`Failed to spawn 'lake env lean --server': ${message}`, {
            cause: error,
          }),
        );
      });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      warn(LOG_CHANNEL, `[${root}] ${chunk.trimEnd()}`);
    });
    child.on('exit', (code, signal) => {
      const tail = stderrTail.slice(-1000);
      info(
        LOG_CHANNEL,
        `lake env lean --server exited (code=${code}, signal=${signal}) at ${root}${tail ? `\n${tail}` : ''}`,
      );
      finalizeServer(
        code === 0 ? 'stopped' : 'error',
        code === 0 ? undefined : `Server exited with code ${code}`,
      );
    });

    const rpc = new JsonRpcConnection(child.stdin, child.stdout);
    this.rpc = rpc;
    rpc.onNotification('textDocument/publishDiagnostics', (params) =>
      this.handlePublishDiagnostics(params as LspPublishDiagnosticsParams),
    );
    rpc.onNotification('window/logMessage', (params) => {
      debug(LOG_CHANNEL, `[${root}] ${JSON.stringify(params)}`);
    });
    rpc.onNotification('window/showMessage', (params) => {
      info(LOG_CHANNEL, `[${root}] ${JSON.stringify(params)}`);
    });

    updateLeanServer(this.id, { pid: child.pid });

    try {
      await pTimeout(
        Promise.race([
          rpc.request('initialize', {
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
          }),
          childError,
        ]),
        {
          milliseconds: HANDSHAKE_TIMEOUT_MS,
          message: 'Lean LSP initialize timeout',
        },
      );
      rpc.notify('initialized', {});
      updateLeanServer(this.id, { status: 'running' });
    } catch (error) {
      updateLeanServer(this.id, {
        status: 'error',
        errorMessage: toErrorMessage(error),
      });
      await this.dispose();
      throw error;
    }
  }

  private async ensureFileOpen(
    absolute: string,
    forceReload: boolean,
  ): Promise<void> {
    this.requireRpc();
    let existing = this.openFiles.get(absolute);
    if (existing && !forceReload) return;
    // Uses fs/promises directly rather than platform().fs: this must read the
    // same real on-disk bytes the spawned `lean --server` process itself sees,
    // not a host's virtual/faked workspace fs.
    const text = await readFile(absolute, 'utf8').catch((error) => {
      throw new Error(`Failed to read ${absolute}: ${toErrorMessage(error)}`, {
        cause: error,
      });
    });
    existing = this.openFiles.get(absolute);
    if (existing && !forceReload) return;
    // Re-check after the await: the session may have been disposed mid-read.
    const rpc = this.requireRpc();
    const version = (existing?.version ?? 0) + 1;
    if (existing) {
      rpc.notify('textDocument/didChange', {
        textDocument: { uri: pathToUri(absolute), version },
        contentChanges: [{ text }],
      });
      existing.version = version;
      existing.diagnostics = [];
      existing.lastDiagnosticsAt = 0;
    } else {
      this.openFiles.set(absolute, {
        version,
        diagnostics: [],
        lastDiagnosticsAt: 0,
        diagnosticsWaiters: [],
      });
      rpc.notify('textDocument/didOpen', {
        textDocument: {
          uri: pathToUri(absolute),
          languageId: LEAN_LANGUAGE_ID,
          version,
          text,
        },
      });
    }
  }

  private async waitForDiagnosticsQuiet(absolute: string): Promise<void> {
    const state = this.openFiles.get(absolute);
    if (!state) return;
    const start = Date.now();
    while (Date.now() - start < DIAGNOSTICS_WAIT_MS) {
      if (this.disposed || this.openFiles.get(absolute) !== state) return;
      const sinceLast = state.lastDiagnosticsAt
        ? Date.now() - state.lastDiagnosticsAt
        : 0;
      if (state.lastDiagnosticsAt && sinceLast >= DIAGNOSTICS_QUIET_WINDOW_MS) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Clean up the waiter entry on timeout.
          const idx = state.diagnosticsWaiters.findIndex(
            (w) => w.timeout === timeout,
          );
          if (idx >= 0) state.diagnosticsWaiters.splice(idx, 1);
          resolve();
        }, DIAGNOSTICS_QUIET_WINDOW_MS);
        state.diagnosticsWaiters.push({ resolve, timeout });
      });
    }
  }

  private handlePublishDiagnostics(params: LspPublishDiagnosticsParams): void {
    const uri = params.uri;
    const absolute = fileUriToPath(uri);
    if (!absolute) return;
    const state = this.openFiles.get(absolute);
    if (!state) return;
    state.diagnostics = params.diagnostics.map(toLeanDiagnostic);
    state.lastDiagnosticsAt = Date.now();
    // Release any waiters — the quiet-window check above re-arms if needed.
    this.releaseDiagnosticsWaiters(state);
  }

  private releaseAllDiagnosticsWaiters(): void {
    for (const state of this.openFiles.values()) {
      this.releaseDiagnosticsWaiters(state);
    }
  }

  private releaseDiagnosticsWaiters(state: OpenedFile): void {
    for (const waiter of state.diagnosticsWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
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
