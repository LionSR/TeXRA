/**
 * VS Code integration with the Lean 4 extension.
 *
 * Provides access to Lean 4 diagnostics and goal state via VS Code's built-in
 * language APIs and the Lean 4 extension's exported API.
 *
 * This module lives in `@frontend/` because it depends on `vscode` APIs.
 * Tool implementations access it via the injectable `LeanLanguageServices`.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';

import { Data, Effect, Result } from 'effect';

import { promptExtensionInstall } from '@frontend/ui/instruction';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { waitForDiagnosticsChange } from '@frontend/vscode/vscodeDiagnostics';
import { createLog } from '@logger/logUtils';
import type { StateStore } from '@platform/interfaces';
import {
  LEAN4_EXTENSION_ID,
  type FetchDiagnosticsResult,
  type LeanDiagnostic,
  type LeanFileCommand,
  type LeanProjectCommand,
  type LspHover,
  type LspResult,
  type PlainGoal,
  type PlainTermGoal,
} from '@tools/lean/leanTypes';
import {
  listLeanServers,
  registerLeanServer,
  unregisterLeanServer,
  updateLeanServer,
} from '@tools/lean/leanServerRegistry';
import type { LeanLanguageServicesShape } from '@tools/lean/leanLanguageServices';
import { isStrictlyWithin } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('VscodeLeanIntegration');

/**
 * Why an editor call in this bridge produced no editor: VS Code would not
 * read the document at all, or it read it and would not show it. The two
 * are separate answers because only the first says anything about the file.
 */
class EditorOpenFailed extends Data.TaggedError('EditorOpenFailed')<{
  readonly reason: 'document-open-failed' | 'editor-unavailable';
  readonly message: string;
  readonly absolutePath: string;
  readonly cause: unknown;
}> {}

/**
 * A Lean 4 command VS Code dispatched and rejected. There is no
 * "not registered" reason: the ids are the extension's own, and VS Code
 * reports an unregistered id the same way it reports a faulting one.
 */
class VscodeCommandFailed extends Data.TaggedError('VscodeCommandFailed')<{
  readonly message: string;
  readonly commandId: string;
  readonly cause: unknown;
}> {}

/**
 * Why the Lean 4 extension could not answer: it is not installed (the user
 * was offered the install), or it is installed and its activation or feature
 * promise rejected. The reasons carry different advice, which the old
 * single "not ready" message gave to both.
 */
class LeanExtensionUnavailable extends Data.TaggedError(
  'LeanExtensionUnavailable',
)<{
  readonly reason: 'not-installed' | 'activation-failed';
  readonly message: string;
  readonly cause?: unknown;
}> {}

const LEAN4_NOT_INSTALLED =
  'The Lean 4 extension is not installed. Install it, then try again.';

const FILE_COMMAND_VSCODE_IDS: Record<LeanFileCommand, string> = {
  restart: 'lean4.restartFile',
  refresh_dependencies: 'lean4.refreshFileDependencies',
};

const PROJECT_COMMAND_VSCODE_IDS: Record<LeanProjectCommand, string> = {
  restart_server: 'lean4.restartServer',
  stop_server: 'lean4.stopServer',
  build: 'lean4.project.build',
  clean: 'lean4.project.clean',
  fetch_cache: 'lean4.project.fetchCache',
  fetch_file_cache: 'lean4.project.fetchFileCache',
  install_elan: 'lean4.setup.installElan',
  install_deps: 'lean4.setup.installDeps',
  update_elan: 'lean4.setup.updateElan',
  select_toolchain: 'lean4.setup.selectDefaultToolchain',
};

const LEAN_FEATURE_PROJECT_COMMANDS = new Set<LeanProjectCommand>([
  'restart_server',
  'stop_server',
  'build',
  'clean',
  'fetch_cache',
  'fetch_file_cache',
]);

/**
 * Record a workspace folder as having an active VS Code-mediated Lean
 * server. Idempotent — called from every code path that successfully
 * reaches the leanprover.lean4 client provider, so the dashboard reflects
 * actual usage rather than a one-shot snapshot. The registry is the one
 * store of which servers exist: an entry already there is refreshed rather
 * than registered again (registering restarts its uptime clock), and an
 * entry dropped elsewhere is registered afresh.
 */
function noteVscodeLeanServer(workspaceRoot: string): void {
  const id = `vscode:${workspaceRoot}`;
  if (listLeanServers().some((server) => server.id === id)) {
    updateLeanServer(id, { status: 'running' });
    return;
  }
  registerLeanServer({
    id,
    workspaceRoot,
    mode: 'vscode-extension',
    status: 'running',
  });
}

function workspaceRootForFile(absolutePath: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(absolutePath),
  );
  return folder?.uri.fsPath ?? path.dirname(absolutePath);
}

/**
 * Clear all VS Code-mediated entries — called on extension deactivation.
 */
export function clearVscodeLeanServerEntries(): void {
  for (const server of listLeanServers()) {
    if (server.mode === 'vscode-extension') unregisterLeanServer(server.id);
  }
}

/**
 * Duck-typed FileUri compatible with the Lean 4 extension's ExtUri.
 * The Lean 4 extension uses custom FileUri/UntitledUri classes (not vscode.Uri)
 * with an `isInFolder` method for client lookup. We replicate the interface here
 * since those classes are internal to the Lean 4 extension.
 *
 * Mirrors: leanprover/vscode-lean4 (tested against v0.4.x)
 * @see https://github.com/leanprover/vscode-lean4/blob/master/vscode-lean4/src/utils/exturi.ts
 */
interface LeanFileUri {
  scheme: 'file';
  fsPath: string;
  isInFolder(folderUri: LeanFileUri): boolean;
  toString(): string;
}

function createLeanFileUri(absolutePath: string): LeanFileUri {
  const uri = vscode.Uri.file(absolutePath);
  return {
    scheme: 'file',
    fsPath: absolutePath,
    // Matches Lean 4 extension's FileUri.isInFolder → isFileInFolder logic.
    // Platform-safe here: both fsPath values use OS-native separators
    // (guaranteed by vscode.Uri.file().fsPath).
    isInFolder: (folderUri: LeanFileUri) =>
      isStrictlyWithin(folderUri.fsPath, absolutePath),
    toString: () => uri.toString(),
  };
}

/**
 * Lean 4 extension client interfaces.
 * Mirrors: leanprover/vscode-lean4 (tested against v0.4.x)
 * @see https://github.com/leanprover/vscode-lean4/blob/master/vscode-lean4/src/leanclient.ts
 * @see https://github.com/leanprover/vscode-lean4/blob/master/vscode-lean4/src/utils/clientProvider.ts
 */
interface LeanClient {
  isRunning(): boolean;
  sendRequest(method: string, params: unknown): Promise<unknown>;
}

interface LeanClientProvider {
  findClient(uri: LeanFileUri): LeanClient | undefined;
}

interface Lean4EnabledFeatures {
  clientProvider: LeanClientProvider;
}

interface Lean4ExtensionApi {
  lean4EnabledFeatures: Promise<Lean4EnabledFeatures>;
}

function toLeanDiagnostic(d: vscode.Diagnostic): LeanDiagnostic {
  return {
    severity: d.severity,
    message: d.message,
    range: {
      start: {
        line: d.range.start.line,
        character: d.range.start.character,
      },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
    source: d.source,
  };
}

/**
 * Get diagnostics for a Lean file using VS Code's diagnostics API.
 * This returns diagnostics from the Lean 4 extension's LSP.
 */
function getDiagnostics(absolutePath: string): LeanDiagnostic[] {
  const uri = vscode.Uri.file(absolutePath);
  const directLookup = vscode.languages.getDiagnostics(uri);
  if (directLookup.length > 0) {
    return directLookup.map(toLeanDiagnostic);
  }

  // Fallback: match by path (case-insensitive) in case URI format differs
  const normalizedTarget = uri.fsPath.toLowerCase();
  for (const [diagUri, diags] of vscode.languages.getDiagnostics()) {
    if (diagUri.fsPath.toLowerCase() === normalizedTarget && diags.length > 0) {
      return diags.map(toLeanDiagnostic);
    }
  }
  return [];
}

/**
 * Open `uri` in an editor, keeping the current focus. Two steps, so a
 * failure says which one VS Code refused.
 */
function openInEditor(uri: vscode.Uri): Effect.Effect<void, EditorOpenFailed> {
  return Effect.gen(function* () {
    const document = yield* Effect.tryPromise({
      try: () => Promise.resolve(vscode.workspace.openTextDocument(uri)),
      catch: (cause) =>
        new EditorOpenFailed({
          reason: 'document-open-failed',
          message: `Could not open ${uri.fsPath}: ${toErrorMessage(cause)}`,
          absolutePath: uri.fsPath,
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          vscode.window.showTextDocument(document, { preserveFocus: true }),
        ),
      catch: (cause) =>
        new EditorOpenFailed({
          reason: 'editor-unavailable',
          message: `Could not show ${uri.fsPath} in an editor: ${toErrorMessage(cause)}`,
          absolutePath: uri.fsPath,
          cause,
        }),
    });
  });
}

/** Run one of the Lean 4 extension's commands. */
function executeLeanCommand(
  commandId: string,
): Effect.Effect<void, VscodeCommandFailed> {
  return Effect.tryPromise({
    try: async () => {
      await vscode.commands.executeCommand(commandId);
    },
    catch: (cause) =>
      new VscodeCommandFailed({
        message: `VS Code command "${commandId}" failed: ${toErrorMessage(cause)}`,
        commandId,
        cause,
      }),
  });
}

function executeFileCommand(
  globalState: StateStore,
  command: LeanFileCommand,
  filePath: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    yield* openInEditor(vscode.Uri.file(filePath));
    yield* getClientProvider(globalState);
    yield* executeLeanCommand(FILE_COMMAND_VSCODE_IDS[command]);
    return true;
  }).pipe(
    // The port answers this one with a boolean, so the reason is only worth
    // saying once — in the log, rather than nowhere as it was before the
    // failures were typed.
    Effect.catch((failure) =>
      Effect.sync(() => {
        log.warn(
          `Lean "${command}" on ${filePath} did not run: ${failure.message}`,
        );
        return false;
      }),
    ),
  );
}

/**
 * Get the Lean 4 extension's client provider, or say why there is none.
 * Prompts the user to install the extension when it is missing; the prompt
 * is an offer, so failing to show it does not change the answer.
 */
function getClientProvider(
  globalState: StateStore,
): Effect.Effect<LeanClientProvider, LeanExtensionUnavailable> {
  return Effect.gen(function* () {
    const lean4Ext =
      vscode.extensions.getExtension<Lean4ExtensionApi>(LEAN4_EXTENSION_ID);
    if (!lean4Ext) {
      yield* Effect.tryPromise({
        try: () =>
          promptExtensionInstall(globalState, {
            suppressKey: 'lean4-install-tool',
            message:
              'Lean 4 extension is required for this operation. Install now?',
            extensionId: LEAN4_EXTENSION_ID,
            channel: 'lean',
          }),
        catch: (cause) =>
          `Could not offer the Lean 4 install prompt: ${toErrorMessage(cause)}`,
      }).pipe(Effect.catch((message) => Effect.sync(() => log.warn(message))));
      return yield* Effect.fail(
        new LeanExtensionUnavailable({
          reason: 'not-installed',
          message: LEAN4_NOT_INSTALLED,
        }),
      );
    }

    const features = yield* Effect.tryPromise({
      try: async () => {
        const api = await lean4Ext.activate();
        return await api.lean4EnabledFeatures;
      },
      catch: (cause) =>
        new LeanExtensionUnavailable({
          reason: 'activation-failed',
          message:
            'The Lean 4 extension is not ready. Open a Lean file in the project, then try again.',
          cause,
        }),
    });
    return features.clientProvider;
  });
}

/**
 * Send an LSP request at a specific position in a Lean file.
 * Opens the file first to ensure the LSP server has processed it. Each
 * failure mode is its own `data: null` answer, as the callers' models read
 * the error text; nothing here throws.
 */
function sendPositionRequest<T>(
  globalState: StateStore,
  absolutePath: string,
  line: number,
  column: number,
  method: string,
): Effect.Effect<LspResult<T>> {
  return Effect.gen(function* () {
    const uri = vscode.Uri.file(absolutePath);
    const leanUri = createLeanFileUri(absolutePath);

    const provider = yield* Effect.result(getClientProvider(globalState));
    if (Result.isFailure(provider)) {
      return { data: null, error: provider.failure.message };
    }

    const opened = yield* Effect.result(openInEditor(uri));
    if (Result.isFailure(opened)) {
      return { data: null, error: opened.failure.message };
    }

    const found = yield* Effect.result(
      Effect.try({
        try: () => provider.success.findClient(leanUri),
        catch: () => undefined,
      }),
    );
    if (Result.isFailure(found)) {
      return {
        data: null,
        error: `Error finding Lean client for ${absolutePath}. Is this file in a Lean project?`,
      };
    }
    const client = found.success;
    if (!client) {
      return {
        data: null,
        error: `No Lean client for ${absolutePath}. Is this file in a Lean project with a lakefile?`,
      };
    }
    if (!client.isRunning()) {
      return {
        data: null,
        error: 'Lean server not running. Try lean_project restart_server.',
      };
    }

    noteVscodeLeanServer(workspaceRootForFile(absolutePath));

    const params = {
      textDocument: { uri: leanUri.toString() },
      position: { line, character: column },
    };
    return yield* Effect.tryPromise({
      try: () => client.sendRequest(method, params),
      catch: (e) => `LSP request ${method} failed: ${toErrorMessage(e)}`,
    }).pipe(
      Effect.map((result) => ({ data: result as T })),
      Effect.catch((error) => Effect.succeed({ data: null, error })),
    );
  });
}

/**
 * Open a Lean file, wait for diagnostics, and return them.
 * The file that could not be opened is the `file_missing` answer; a rejected
 * host call fails the effect.
 */
function fetchDiagnosticsForFile(
  absolutePath: string,
): Effect.Effect<FetchDiagnosticsResult> {
  return Effect.gen(function* () {
    // Subscribed before the file is opened, so an update the open itself
    // triggers is not missed. `Effect.sync` starts that wait here; the
    // program awaits the same promise below.
    const diagnosticsWait = yield* Effect.sync(() =>
      waitForDiagnosticsChange(vscode.Uri.file(absolutePath), 10000),
    );

    const opened = yield* Effect.promise(() =>
      openFileInEditor(absolutePath, { preserveFocus: true }),
    );
    if (!opened) {
      // Could not be opened in the editor — the file itself is the problem.
      return {
        ok: false,
        kind: 'file_missing',
        message: `Could not open ${absolutePath} in the editor.`,
      } satisfies FetchDiagnosticsResult;
    }

    noteVscodeLeanServer(workspaceRootForFile(absolutePath));

    yield* Effect.promise(() => diagnosticsWait);
    return {
      ok: true,
      diagnostics: getDiagnostics(opened.absolutePath),
    } satisfies FetchDiagnosticsResult;
  });
}

/** Navigate editor to first error location if present. */
function navigateToFirstError(
  filePath: string,
  diagnostics: LeanDiagnostic[],
): Effect.Effect<void> {
  const firstError = diagnostics.find(
    (d) => d.severity === vscode.DiagnosticSeverity.Error,
  );
  if (!firstError) return Effect.void;
  // `openFileInEditor` reports a refusal by returning nothing, having
  // already logged it, so this navigation has no failure of its own.
  return Effect.promise(() =>
    openFileInEditor(filePath, { line: firstError.range.start.line + 1 }),
  );
}

function executeProjectCommand(
  globalState: StateStore,
  command: LeanProjectCommand,
): Effect.Effect<void, LeanExtensionUnavailable | VscodeCommandFailed> {
  return Effect.gen(function* () {
    if (LEAN_FEATURE_PROJECT_COMMANDS.has(command)) {
      // vscode-lean4 registers these commands in activateLean4Features(), not
      // during its initial extension activation. Awaiting the exported feature
      // promise prevents a race with command registration after a Lean file opens.
      // Its failure is already the "extension cannot answer" report the tool
      // shows, told apart by reason instead of by one message for both.
      yield* getClientProvider(globalState);
    }
    yield* executeLeanCommand(PROJECT_COMMAND_VSCODE_IDS[command]);
  });
}

/**
 * Build the VS Code-mediated `LeanLanguageServices` adapter, which
 * `extension.ts` provides to the process runtime. The single exported surface
 * of this module's language operations: the implementing functions above are
 * module-private so the export list states exactly what the host consumes.
 * The adapter closes over the extension's own global-state store, which the
 * install prompt's suppression keys are read from and written to; the module
 * never looks a store up for itself.
 */
export function createVscodeLeanLanguageServices(
  globalState: StateStore,
): LeanLanguageServicesShape {
  return Object.freeze({
    executeFileCommand: (command, filePath) =>
      executeFileCommand(globalState, command, filePath),
    // Positions are 0-indexed line and column; each of the three position
    // queries below names the Lean 4 extension's own LSP method.
    getGoalState: (filePath, line, column) =>
      sendPositionRequest<PlainGoal>(
        globalState,
        filePath,
        line,
        column,
        '$/lean/plainGoal',
      ),
    getTermGoal: (filePath, line, column) =>
      sendPositionRequest<PlainTermGoal>(
        globalState,
        filePath,
        line,
        column,
        '$/lean/plainTermGoal',
      ),
    getHoverInfo: (filePath, line, column) =>
      sendPositionRequest<LspHover>(
        globalState,
        filePath,
        line,
        column,
        'textDocument/hover',
      ),
    fetchDiagnosticsForFile,
    navigateToFirstError,
    executeProjectCommand: (command) =>
      executeProjectCommand(globalState, command),
  } satisfies LeanLanguageServicesShape);
}
