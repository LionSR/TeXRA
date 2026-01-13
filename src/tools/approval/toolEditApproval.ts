// Third-party imports
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  diff_match_patch,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
} from 'diff-match-patch';
import * as vscode from 'vscode';
import * as difflib from 'difflib';

// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - utils
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { isLatexFile } from '@common/files/fileTypeUtils';
import { bus } from '@eventBus/ProgressEventBus';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { TEMP_EXTENSIONS } from '@housekeeping/constants';
import { LaTeXdiffService } from '@latex/latexdiff';
import { type ToolResult, type LineChanges } from '@tools/result';
import { getConfig } from '@utils/config';
import { WorkspaceFS, pathToLocation } from '@utils/files';

// Local file imports

export interface ToolEditApprovalRequest {
  path: string;
  originalContent: string;
  proposedContent: string;
  sourceTool: string;
  streamId?: StreamTabId;
}

export interface ToolEditApprovalResult {
  accepted: boolean;
  userMessage?: string;
  appliedContent?: string;
  userPatch?: string;
  lineChanges?: LineChanges;
}

export const TOOL_EDIT_APPROVAL_CONFIG_KEY =
  'texra.toolUse.requireEditApproval';

const REVEAL_TIMEOUT_MS = 1500;

interface PendingApprovalEntry {
  request: ToolEditApprovalRequest;
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
  originalContent: string;
  proposedContent: string;
  title: string;
  streamId?: StreamTabId;
  lineChanges: LineChanges;
  isSettled: () => boolean;
  settle: (result: ToolEditApprovalResult) => void;
  /** Cleanup functions for workspace temp files created by preview/latexdiff */
  workspaceTempCleanup: Array<() => Promise<void>>;
}

/** All valid approval actions for tool edit prompts */
export const PROGRESS_VIEW_APPROVAL_ACTIONS = [
  'approve',
  'reject',
  'openDiff',
  'approveAll',
  'resumeApprovals',
  'showLatexdiff',
  'previewProposed',
] as const;

export type ProgressViewApprovalAction =
  (typeof PROGRESS_VIEW_APPROVAL_ACTIONS)[number];

interface ProgressViewApprovalActionPayload {
  requestId: string;
  action: ProgressViewApprovalAction;
  note?: string;
}

let queue: Promise<void> = Promise.resolve();
let initialized = false;
let customHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;
let approvalCounter = 0;
const pendingApprovals = new Map<string, PendingApprovalEntry>();
let approvalsBypassedForSession = false;
let storageDirectory: string | undefined;
const activePreviewFiles = new Set<string>();

function notifyProgressViewApprovalBypassState(): void {
  if (!initialized) {
    return;
  }
  bus.emit('updateToolEditApprovalBypassState', {
    bypassActive: approvalsBypassedForSession,
  });
}

function getStorageDir(): string {
  if (!storageDirectory) {
    throw new Error('Tool edit approval has not been initialized.');
  }
  return storageDirectory;
}

async function ensureStorageDir(): Promise<string> {
  const dir = getStorageDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function createTempFile(
  side: 'original' | 'proposed',
  targetPath: string,
  content: string,
): Promise<vscode.Uri> {
  const dir = await ensureStorageDir();
  const ext = path.extname(targetPath) || '.txt';
  const fileName = `${randomUUID()}-${side}${ext}`;
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, content, 'utf8');
  activePreviewFiles.add(filePath);
  return vscode.Uri.file(filePath);
}

async function cleanupTempFile(uri: vscode.Uri): Promise<void> {
  activePreviewFiles.delete(uri.fsPath);
  await fs.unlink(uri.fsPath).catch(() => {});
}

async function readCurrentContent(
  uri: vscode.Uri,
  fallback: string,
): Promise<string> {
  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString(),
  );
  if (openDocument) {
    return openDocument.getText();
  }

  try {
    return await fs.readFile(uri.fsPath, 'utf8');
  } catch (_err) {
    return fallback;
  }
}

function enableSessionApprovalBypass(): void {
  approvalsBypassedForSession = true;
  notifyProgressViewApprovalBypassState();
}

export function setToolEditApprovalSessionBypass(enabled: boolean): void {
  approvalsBypassedForSession = enabled;
  notifyProgressViewApprovalBypassState();
}

export function resetToolEditApprovalSessionBypass(): void {
  setToolEditApprovalSessionBypass(false);
}

export function initializeToolEditApproval(
  context: vscode.ExtensionContext,
): void {
  if (initialized) {
    return;
  }
  const baseDir = context.storageUri ?? context.globalStorageUri;
  storageDirectory = path.join(baseDir.fsPath, 'tool-edit-previews');
  initialized = true;
}

export function setToolEditApprovalHandler(
  handler?: (
    request: ToolEditApprovalRequest,
  ) => Promise<ToolEditApprovalResult>,
): void {
  customHandler = handler;
}

async function showProgressViewApprovalPrompt(
  requestId: string,
  request: ToolEditApprovalRequest,
  relativePath: string,
  lineChanges: LineChanges,
): Promise<void> {
  await safeExecuteCommand('texra.showProgressView');
  bus.emit('showToolEditApprovalPrompt', {
    requestId,
    path: request.path,
    relativePath,
    sourceTool: request.sourceTool,
    allowBypass: !approvalsBypassedForSession,
    streamId: request.streamId ?? '',
    addedLines: lineChanges.added,
    removedLines: lineChanges.removed,
    isLatex: isLatexFile(request.path),
  });
}

function resolveProgressViewApprovalPrompt(requestId: string): void {
  bus.emit('resolveToolEditApprovalPrompt', { requestId });
}

function countNewlines(value: string): number {
  return (value.match(/\n/g) ?? []).length;
}

function countChangedLines(text: string): number {
  if (!text) {
    return 0;
  }

  const normalized = text.replaceAll('\r\n', '\n');
  const segments = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    return Math.max(segments.length - 1, 0);
  }
  return segments.length;
}

function computeLineChangeSummary(
  original: string,
  proposed: string,
): LineChanges {
  if (original === proposed) {
    return { added: 0, removed: 0 };
  }

  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, proposed);
  dmp.diff_cleanupSemantic(diffs);

  let added = 0;
  let removed = 0;

  for (const [type, text] of diffs) {
    if (!text) {
      continue;
    }

    if (type === DIFF_INSERT) {
      added += countChangedLines(text);
    } else if (type === DIFF_DELETE) {
      removed += countChangedLines(text);
    }
  }

  return { added, removed };
}

function firstChangedLine(original: string, proposed: string): number | null {
  if (original === proposed) {
    return null;
  }

  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, proposed);
  dmp.diff_cleanupSemantic(diffs);

  let originalLine = 0;
  let proposedLine = 0;

  for (const [type, text] of diffs) {
    switch (type) {
      case DIFF_EQUAL: {
        const newlineCount = countNewlines(text);
        originalLine += newlineCount;
        proposedLine += newlineCount;
        break;
      }
      case DIFF_INSERT:
        return proposedLine;
      case DIFF_DELETE:
        return Math.max(proposedLine - 1, 0);
      default:
        break;
    }
  }

  return 0;
}

interface ComputeUserPatchOptions {
  contextLines?: number;
}

function computeUserPatch(
  path: string,
  suggestedContent: string,
  appliedContent: string,
  options?: ComputeUserPatchOptions,
): string | undefined {
  if (suggestedContent === appliedContent) {
    return undefined;
  }

  const diffOptions: Record<string, unknown> = {
    fromfile: `${path} (proposed)`,
    tofile: `${path} (final)`,
    lineterm: '',
  };

  const contextLines = options?.contextLines ?? 3;
  if (Number.isInteger(contextLines)) {
    diffOptions.n = contextLines;
  }

  const diffLines = difflib.unifiedDiff(
    suggestedContent.split('\n'),
    appliedContent.split('\n'),
    diffOptions,
  );

  if (!diffLines || diffLines.length === 0) {
    return undefined;
  }

  return diffLines.join('\n');
}

async function revealFirstChange(
  proposedUri: vscode.Uri,
  originalContent: string,
  proposedContent: string,
): Promise<void> {
  const line = firstChangedLine(originalContent, proposedContent);
  if (line === null) {
    return;
  }

  const targetUri = proposedUri.toString();
  const position = new vscode.Position(line, 0);

  const tryReveal = () => {
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === targetUri,
    );

    if (!editor) {
      return false;
    }

    editor.selections = [new vscode.Selection(position, position)];
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter,
    );
    return true;
  };

  if (tryReveal()) {
    return;
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const disposable = vscode.window.onDidChangeVisibleTextEditors(() => {
      if (!resolved && tryReveal()) {
        resolved = true;
        disposeAll();
        resolve();
      }
    });

    function disposeAll() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      disposable.dispose();
    }

    timer = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      disposeAll();
      tryReveal();
      resolve();
    }, REVEAL_TIMEOUT_MS);
  });
}

async function closeApprovalEditors(
  originalUri: vscode.Uri,
  proposedUri: vscode.Uri,
): Promise<void> {
  const targetUris = new Set([originalUri.toString(), proposedUri.toString()]);

  const tabsToClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        typeof vscode.TabInputTextDiff !== 'undefined' &&
        input instanceof vscode.TabInputTextDiff
      ) {
        const original = input.original.toString();
        const modified = input.modified.toString();
        if (targetUris.has(original) && targetUris.has(modified)) {
          tabsToClose.push(tab);
        }
        continue;
      }

      if (
        typeof vscode.TabInputText !== 'undefined' &&
        input instanceof vscode.TabInputText
      ) {
        if (targetUris.has(input.uri.toString())) {
          tabsToClose.push(tab);
        }
      }
    }
  }

  if (tabsToClose.length > 0) {
    await vscode.window.tabGroups.close(tabsToClose);
  }
}

const latexdiffService = new LaTeXdiffService('ToolEditApproval');

/**
 * Create a temporary file in the same directory as the original for LaTeX compilation.
 * Placing the temp file alongside the original ensures \input{}, \include{}, and
 * relative paths resolve correctly (they're relative to the file's directory).
 * Returns the temp file path and a cleanup function.
 */
async function createWorkspaceTempFile(
  originalPath: string,
  content: string,
  suffix: string,
): Promise<{ tempPath: string; cleanup: () => Promise<void> }> {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    throw new Error('No workspace folder open');
  }

  // Resolve the original path relative to workspace
  const absoluteOriginal = path.isAbsolute(originalPath)
    ? originalPath
    : path.join(workspacePath, originalPath);

  const ext = path.extname(originalPath);
  const basename = path.basename(originalPath, ext);
  const originalDir = path.dirname(absoluteOriginal);

  // Create temp file in the SAME directory as original so relative paths work
  const tempFileName = `${basename}${suffix}-${randomUUID().slice(0, 8)}${ext}`;
  const tempPath = path.join(originalDir, tempFileName);

  await fs.writeFile(tempPath, content, 'utf8');

  const cleanup = async () => {
    try {
      // Clean up the main temp file
      await fs.unlink(tempPath).catch(() => {});
      // Clean up all LaTeX auxiliary files using shared TEMP_EXTENSIONS
      const basePathNoExt = tempPath.slice(0, -ext.length);
      for (const tempExt of TEMP_EXTENSIONS) {
        await fs.unlink(basePathNoExt + tempExt).catch(() => {});
      }
    } catch {
      // Ignore cleanup errors
    }
  };

  return { tempPath, cleanup };
}

/**
 * Preview the proposed LaTeX document by creating a temp file in the same directory.
 * This ensures \input{}, \include{}, and relative paths resolve correctly.
 * Cleanup is registered with the entry and executed when approval is resolved.
 */
async function previewProposedLatex(entry: PendingApprovalEntry): Promise<void> {
  try {
    // Read current content from proposed file (user may have edited it)
    const content = await fs.readFile(entry.proposedUri.fsPath, 'utf8');

    // Create temp file in workspace for proper dependency resolution
    const { tempPath, cleanup } = await createWorkspaceTempFile(
      entry.request.path,
      content,
      '_preview',
    );

    // Register cleanup to run when approval is resolved
    entry.workspaceTempCleanup.push(cleanup);

    // Open and build the temp file
    const tempLocation = pathToLocation(tempPath);
    await openBuildDisplayIfTex(tempLocation, { preserveFocus: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Preview failed: ${message}`);
  }
}

/**
 * Run latexdiff on the original and proposed content.
 * Creates temp files in the same directory as the original for proper path resolution.
 * Cleanup is registered with the entry and executed when approval is resolved.
 */
async function runLatexdiffForApproval(
  entry: PendingApprovalEntry,
): Promise<void> {
  try {
    // Read current content from files (user may have edited proposed in diff view)
    const originalContent = await fs.readFile(entry.originalUri.fsPath, 'utf8');
    const proposedContent = await fs.readFile(entry.proposedUri.fsPath, 'utf8');

    // Create temp files in workspace for proper dependency resolution
    const original = await createWorkspaceTempFile(
      entry.request.path,
      originalContent,
      '_original',
    );
    entry.workspaceTempCleanup.push(original.cleanup);

    const proposed = await createWorkspaceTempFile(
      entry.request.path,
      proposedContent,
      '_proposed',
    );
    entry.workspaceTempCleanup.push(proposed.cleanup);

    // Run latexdiff on the workspace temp files
    const originalLocation = pathToLocation(original.tempPath);
    const proposedLocation = pathToLocation(proposed.tempPath);

    const result = await latexdiffService.runDiff(
      originalLocation,
      proposedLocation,
      '_diff',
      false, // don't run indent
      'coarse', // default math markup
    );

    if (!result.success || !result.diffFileName) {
      vscode.window.showErrorMessage(
        result.message ?? 'Failed to generate LaTeXdiff',
      );
      return;
    }

    // Open the generated diff file in the LaTeX build preview
    const diffFilePath = path.join(
      path.dirname(original.tempPath),
      result.diffFileName,
    );
    const diffLocation = pathToLocation(diffFilePath);
    await openBuildDisplayIfTex(diffLocation, { preserveFocus: true });

    // Register cleanup for diff file and its aux files
    const ext = path.extname(diffFilePath);
    const diffBasePathNoExt = diffFilePath.slice(0, -ext.length);
    entry.workspaceTempCleanup.push(async () => {
      await fs.unlink(diffFilePath).catch(() => {});
      for (const tempExt of TEMP_EXTENSIONS) {
        await fs.unlink(diffBasePathNoExt + tempExt).catch(() => {});
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`LaTeXdiff failed: ${message}`);
  }
}

async function nativeRequestApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  getStorageDir(); // Validates initialization

  const { path, originalContent, proposedContent, sourceTool, streamId } =
    request;

  approvalCounter += 1;
  const requestId = `approval-${Date.now().toString(36)}-${approvalCounter}`;
  const originalUri = await createTempFile('original', path, originalContent);
  const proposedUri = await createTempFile('proposed', path, proposedContent);

  const description = vscode.workspace.asRelativePath(
    WorkspaceFS.fullPath(path),
  );
  const lineChanges = computeLineChangeSummary(
    originalContent,
    proposedContent,
  );
  const totalChanged = Math.max(lineChanges.added + lineChanges.removed, 0);
  const changeSummaryParts: string[] = [];
  if (lineChanges.added > 0) {
    changeSummaryParts.push(`+${lineChanges.added}`);
  }
  if (lineChanges.removed > 0) {
    changeSummaryParts.push(`-${lineChanges.removed}`);
  }
  const changeSummary =
    changeSummaryParts.length > 0
      ? `${changeSummaryParts.join(' / ')} ${
          totalChanged === 1 ? 'line' : 'lines'
        }`
      : undefined;

  const titleDetails = changeSummary
    ? `${description} · ${changeSummary}`
    : description;
  const title = `Tool edit (${sourceTool}): ${titleDetails}`;
  let result: ToolEditApprovalResult = { accepted: false };
  try {
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      title,
    );

    await revealFirstChange(proposedUri, originalContent, proposedContent);

    result = await new Promise<ToolEditApprovalResult>((resolve) => {
      let settled = false;

      const settle = (value: ToolEditApprovalResult) => {
        if (settled) {
          return;
        }
        settled = true;
        pendingApprovals.delete(requestId);
        resolve(value);
      };

      const entry: PendingApprovalEntry = {
        request,
        originalUri,
        proposedUri,
        originalContent,
        proposedContent,
        title,
        streamId,
        lineChanges,
        isSettled: () => settled,
        settle,
        workspaceTempCleanup: [],
      };

      pendingApprovals.set(requestId, entry);
      void showProgressViewApprovalPrompt(
        requestId,
        request,
        description,
        lineChanges,
      );
    });

    if (result.accepted) {
      const appliedContent = await readCurrentContent(
        proposedUri,
        proposedContent,
      );
      const userPatch = computeUserPatch(
        request.path,
        proposedContent,
        appliedContent,
      );
      result = {
        ...result,
        appliedContent,
        userPatch,
      };
    }

    return {
      ...result,
      lineChanges: result.lineChanges ?? lineChanges,
    };
  } finally {
    // Get entry before deleting to access workspace temp cleanup functions
    const entry = pendingApprovals.get(requestId);
    pendingApprovals.delete(requestId);
    await closeApprovalEditors(originalUri, proposedUri);
    await cleanupTempFile(originalUri);
    await cleanupTempFile(proposedUri);

    // Clean up any workspace temp files created by preview/latexdiff
    if (entry?.workspaceTempCleanup) {
      for (const cleanup of entry.workspaceTempCleanup) {
        await cleanup().catch(() => {});
      }
    }

    resolveProgressViewApprovalPrompt(requestId);
  }
}

async function enqueueApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  const run = async () => {
    if (approvalsBypassedForSession) {
      return { accepted: true };
    }
    return customHandler
      ? customHandler(request)
      : nativeRequestApproval(request);
  };

  const operation = queue.then(run);
  queue = operation.then(
    () => {},
    () => {},
  );
  return operation;
}

export async function requestToolEditApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  const approvalsEnabled = getConfig<boolean>(
    TOOL_EDIT_APPROVAL_CONFIG_KEY,
    true,
  );

  const context = getCurrentToolFileInteractionContext();
  const preparedRequest =
    request.streamId || !context?.streamId
      ? request
      : { ...request, streamId: context.streamId };

  if (!approvalsEnabled || approvalsBypassedForSession) {
    return finalizeApprovalResult({ accepted: true }, preparedRequest);
  }

  const result = await enqueueApproval(preparedRequest);
  return finalizeApprovalResult(result, preparedRequest);
}

function finalizeApprovalResult(
  result: ToolEditApprovalResult,
  request: ToolEditApprovalRequest,
): ToolEditApprovalResult {
  if (!result.accepted) {
    return result;
  }

  const appliedContent = result.appliedContent ?? request.proposedContent;
  const userPatch =
    result.userPatch !== undefined
      ? result.userPatch
      : computeUserPatch(request.path, request.proposedContent, appliedContent);

  return {
    ...result,
    appliedContent,
    userPatch,
    lineChanges:
      result.lineChanges ??
      computeLineChangeSummary(request.originalContent, appliedContent),
  };
}

export function getApprovedContent(
  approval: ToolEditApprovalResult,
  fallback: string,
): string {
  return approval.appliedContent ?? fallback;
}

// (legacy formatting removed; use formatUnifiedApprovalUserDiff instead)

/**
 * Render a human-readable, line-numbered unified diff for user adjustments.
 * Uses difflib to compute a unified diff between the suggested and applied
 * contents, including hunk headers with line ranges.
 */
export function formatUnifiedApprovalUserDiff(
  path: string,
  suggestedContent: string,
  appliedContent: string,
  options?: { contextLines?: number },
): string | undefined {
  const diffBody = computeUserPatch(
    path,
    suggestedContent,
    appliedContent,
    options,
  );

  if (!diffBody) {
    return undefined;
  }

  return `User adjustments to ${path}:\n\n\`\`\`diff\n${diffBody}\n\`\`\``;
}

export interface WriteApprovedContentResult {
  appliedContent: string;
  baseContent: string;
}

export async function writeApprovedContent(
  path: string,
  originalContent: string,
  finalContent: string,
): Promise<WriteApprovedContentResult> {
  const exists = await WorkspaceFS.exists(path);
  if (!exists) {
    await WorkspaceFS.write(path, finalContent);
    return { appliedContent: finalContent, baseContent: '' };
  }

  const currentContent = await WorkspaceFS.read(path);
  if (currentContent === finalContent) {
    return { appliedContent: finalContent, baseContent: currentContent };
  }

  if (currentContent === originalContent) {
    await WorkspaceFS.write(path, finalContent);
    return { appliedContent: finalContent, baseContent: currentContent };
  }

  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(originalContent, finalContent);
  const [patchedContent, results] = dmp.patch_apply(patches, currentContent);

  if (results.every(Boolean)) {
    await WorkspaceFS.write(path, patchedContent);
    return { appliedContent: patchedContent, baseContent: currentContent };
  }

  await WorkspaceFS.write(path, finalContent);
  return { appliedContent: finalContent, baseContent: currentContent };
}

export async function handleProgressViewToolEditApprovalAction(
  payload: ProgressViewApprovalActionPayload,
): Promise<void> {
  const entry = pendingApprovals.get(payload.requestId);
  if (!entry) {
    return;
  }

  if (payload.action === 'openDiff') {
    if (entry.isSettled()) {
      return;
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      entry.originalUri,
      entry.proposedUri,
      entry.title,
    );
    await revealFirstChange(
      entry.proposedUri,
      entry.originalContent,
      entry.proposedContent,
    );
    return;
  }

  if (payload.action === 'showLatexdiff') {
    if (entry.isSettled()) {
      return;
    }

    // Run latexdiff on the original and proposed temp files
    await runLatexdiffForApproval(entry);
    return;
  }

  if (payload.action === 'previewProposed') {
    if (entry.isSettled()) {
      return;
    }

    // Compile and preview the proposed LaTeX document in workspace context
    await previewProposedLatex(entry);
    return;
  }

  if (entry.isSettled()) {
    return;
  }

  if (payload.action === 'approve') {
    // Read the current content from the proposed file - user may have modified it in the diff view
    try {
      const appliedContent = await fs.readFile(entry.proposedUri.fsPath, 'utf-8');
      entry.settle({ accepted: true, appliedContent });
    } catch {
      // Fall back to original proposed content if file read fails
      entry.settle({ accepted: true, appliedContent: entry.proposedContent });
    }
    return;
  }

  if (payload.action === 'approveAll') {
    enableSessionApprovalBypass();
    // Read the current content from the proposed file - user may have modified it in the diff view
    try {
      const appliedContent = await fs.readFile(entry.proposedUri.fsPath, 'utf-8');
      entry.settle({ accepted: true, appliedContent });
    } catch {
      // Fall back to original proposed content if file read fails
      entry.settle({ accepted: true, appliedContent: entry.proposedContent });
    }
    return;
  }

  if (payload.action === 'resumeApprovals') {
    resetToolEditApprovalSessionBypass();
    return;
  }

  if (payload.action === 'reject') {
    let userMessage = payload.note?.trim();
    if (!userMessage) {
      const note = await vscode.window.showInputBox({
        prompt: 'Optionally share why the change was rejected',
        placeHolder: 'Add guidance for the assistant (press Enter to skip)',
      });
      // If user pressed Escape, cancel the rejection and keep waiting
      if (note === undefined) {
        return;
      }
      userMessage = note.trim();
    }

    entry.settle({
      accepted: false,
      userMessage: userMessage || undefined,
    });
  }
}

export function buildApprovalRejectedResult(
  path: string,
  sourceTool: string,
  userMessage?: string,
): ToolResult {
  const baseMessage = `User rejected ${sourceTool} for ${path}.`;
  // Always mark rejections as errors so logs, status, and tests reflect failure,
  // while still forwarding any user note as explicit instruction for the model.
  const note = userMessage?.trim();
  const result: ToolResult = {
    // Use output to ensure the rejection message is always shown to the model.
    // formatToolResultAsText prioritizes output over error/summary.
    output: baseMessage,
    summary: baseMessage,
    error: baseMessage,
    isError: true,
    ...(note && note.length > 0 ? { userInstruction: note } : {}),
  };

  // No file attachments for user notes; treated purely as guidance via fields.

  return result;
}
