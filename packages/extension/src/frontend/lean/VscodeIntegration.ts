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

import { promptExtensionInstall } from '@frontend/ui/instruction';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { waitForDiagnosticsChange } from '@frontend/vscode/vscodeDiagnostics';
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
  registerLeanServer,
  unregisterLeanServer,
  updateLeanServer,
} from '@tools/lean/leanServerRegistry';
import type { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { isStrictlyWithin } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

const knownExtensionServers = new Set<string>();

/**
 * Record a workspace folder as having an active VS Code-mediated Lean
 * server. Idempotent — called from every code path that successfully
 * reaches the leanprover.lean4 client provider, so the dashboard reflects
 * actual usage rather than a one-shot snapshot.
 */
function noteVscodeLeanServer(workspaceRoot: string): void {
  const id = `vscode:${workspaceRoot}`;
  if (knownExtensionServers.has(id)) {
    updateLeanServer(id, { status: 'running' });
    return;
  }
  knownExtensionServers.add(id);
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
  for (const id of knownExtensionServers) {
    unregisterLeanServer(id);
  }
  knownExtensionServers.clear();
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
  isInFolderManagedByThisClient(uri: LeanFileUri): boolean;
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
function getDiagnostics(filePath: string): LeanDiagnostic[] {
  const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
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

async function executeFileCommand(
  command: LeanFileCommand,
  filePath: string,
): Promise<boolean> {
  try {
    const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preserveFocus: true });
    if (!(await getClientProvider())) return false;
    await vscode.commands.executeCommand(FILE_COMMAND_VSCODE_IDS[command]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the Lean 4 extension's client provider.
 * Returns null if the extension is not installed or not ready.
 * Prompts user to install the extension if not found.
 */
async function getClientProvider(): Promise<LeanClientProvider | null> {
  const lean4Ext =
    vscode.extensions.getExtension<Lean4ExtensionApi>(LEAN4_EXTENSION_ID);
  if (!lean4Ext) {
    await promptExtensionInstall({
      suppressKey: 'lean4-install-tool',
      message: 'Lean 4 extension is required for this operation. Install now?',
      extensionId: LEAN4_EXTENSION_ID,
      channel: 'lean',
    });
    return null;
  }

  const api = await lean4Ext.activate();
  const features = await api.lean4EnabledFeatures;
  return features.clientProvider;
}

/**
 * Send an LSP request at a specific position in a Lean file.
 * Opens the file first to ensure the LSP server has processed it.
 */
async function sendPositionRequest<T>(
  filePath: string,
  line: number,
  column: number,
  method: string,
): Promise<LspResult<T>> {
  const absolutePath = WorkspaceFS.toAbsolute(filePath);
  const uri = vscode.Uri.file(absolutePath);
  const leanUri = createLeanFileUri(absolutePath);

  const clientProvider = await getClientProvider().catch(() => null);
  if (!clientProvider) {
    return { data: null, error: 'Lean 4 extension not found or not activated' };
  }

  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preserveFocus: true });
  } catch (e) {
    return {
      data: null,
      error: `Failed to open file ${absolutePath}: ${toErrorMessage(e)}`,
    };
  }

  let client: LeanClient | undefined;
  try {
    client = clientProvider.findClient(leanUri);
  } catch {
    return {
      data: null,
      error: `Error finding Lean client for ${absolutePath}. Is this file in a Lean project?`,
    };
  }
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

  try {
    const params = {
      textDocument: { uri: leanUri.toString() },
      position: { line, character: column },
    };
    const result = await client.sendRequest(method, params);
    return { data: result as T };
  } catch (e) {
    return {
      data: null,
      error: `LSP request ${method} failed: ${toErrorMessage(e)}`,
    };
  }
}

/**
 * Get the proof goal state at a specific position in a Lean file.
 * @param line - 0-indexed line number
 * @param column - 0-indexed column number
 */
async function getGoalState(
  filePath: string,
  line: number,
  column: number,
): Promise<LspResult<PlainGoal>> {
  return sendPositionRequest<PlainGoal>(
    filePath,
    line,
    column,
    '$/lean/plainGoal',
  );
}

/**
 * Get the expected type (term goal) at a specific position in a Lean file.
 * @param line - 0-indexed line number
 * @param column - 0-indexed column number
 */
async function getTermGoal(
  filePath: string,
  line: number,
  column: number,
): Promise<LspResult<PlainTermGoal>> {
  return sendPositionRequest<PlainTermGoal>(
    filePath,
    line,
    column,
    '$/lean/plainTermGoal',
  );
}

/**
 * Get hover information (type + docs) at a specific position in a Lean file.
 * @param line - 0-indexed line number
 * @param column - 0-indexed column number
 */
async function getHoverInfo(
  filePath: string,
  line: number,
  column: number,
): Promise<LspResult<LspHover>> {
  return sendPositionRequest<LspHover>(
    filePath,
    line,
    column,
    'textDocument/hover',
  );
}

/**
 * Open a Lean file, wait for diagnostics, and return them.
 * Returns null if the file could not be opened.
 */
async function fetchDiagnosticsForFile(
  file: string,
): Promise<FetchDiagnosticsResult> {
  const absolutePath = WorkspaceFS.toAbsolute(file);
  const diagnosticsWait = waitForDiagnosticsChange(
    vscode.Uri.file(absolutePath),
    10000,
  );

  const opened = await openFileInEditor(file, { preserveFocus: true });
  if (!opened) {
    // Could not be opened in the editor — the file itself is the problem.
    return {
      ok: false,
      kind: 'file_missing',
      message: `Could not open ${absolutePath} in the editor.`,
    };
  }

  noteVscodeLeanServer(workspaceRootForFile(absolutePath));

  await diagnosticsWait;
  return { ok: true, diagnostics: getDiagnostics(opened.absolutePath) };
}

/** Navigate editor to first error location if present. */
async function navigateToFirstError(
  filePath: string,
  diagnostics: LeanDiagnostic[],
): Promise<void> {
  const firstError = diagnostics.find(
    (d) => d.severity === vscode.DiagnosticSeverity.Error,
  );
  if (firstError) {
    await openFileInEditor(filePath, { line: firstError.range.start.line + 1 });
  }
}

async function executeProjectCommand(
  command: LeanProjectCommand,
): Promise<void> {
  if (LEAN_FEATURE_PROJECT_COMMANDS.has(command)) {
    // vscode-lean4 registers these commands in activateLean4Features(), not
    // during its initial extension activation. Awaiting the exported feature
    // promise prevents a race with command registration after a Lean file opens.
    const clientProvider = await getClientProvider();
    if (!clientProvider) {
      throw new Error(
        'The Lean 4 extension is not ready. Open a Lean file in the project, then try again.',
      );
    }
  }
  await vscode.commands.executeCommand(PROJECT_COMMAND_VSCODE_IDS[command]);
}

/**
 * The VS Code-mediated `LeanLanguageServices` adapter, installed by
 * `extension.ts` via `setLeanLanguageServices`. The single exported surface
 * of this module's language operations: the implementing functions above are
 * module-private so the export list states exactly what the host consumes.
 * Frozen because the object is a shared module-level singleton handed across
 * a package boundary — no consumer may reassign a member.
 */
export const vscodeLeanLanguageServices = Object.freeze({
  executeFileCommand,
  getGoalState,
  getTermGoal,
  getHoverInfo,
  fetchDiagnosticsForFile,
  navigateToFirstError,
  executeProjectCommand,
} satisfies LeanLanguageServices);
