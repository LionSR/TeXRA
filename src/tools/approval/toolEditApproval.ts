// Third-party imports
import {
  diff_match_patch,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
} from 'diff-match-patch';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - utils
import { toolResult, type ToolResult } from '@tools/result';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { safeExecuteCommand } from '@utils/system/commandUtils';
import { getCurrentToolEditApprovalContext } from './toolEditApprovalContext';

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
  isSettled: () => boolean;
  settle: (result: ToolEditApprovalResult) => void;
}

type ProgressViewApprovalAction =
  | 'approve'
  | 'reject'
  | 'openDiff'
  | 'approveAll'
  | 'resumeApprovals';

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

async function notifyProgressViewApprovalBypassState(): Promise<void> {
  if (!initialized) {
    return;
  }
  try {
    const { ProgressViewProvider } = await import(
      '@progressView/ProgressViewProvider'
    );
    ProgressViewProvider.getInstance()?.updateToolEditApprovalBypassState(
      approvalsBypassedForSession,
    );
  } catch (error) {
    console.warn('Unable to broadcast approval bypass state', error);
  }
}

async function ensureStorageDir(): Promise<string> {
  if (!initialized || !storageDirectory) {
    throw new Error('Tool edit approval has not been initialized.');
  }

  await fs.mkdir(storageDirectory, { recursive: true });
  return storageDirectory;
}

function resolveTempExtension(targetPath: string): string {
  const ext = path.extname(targetPath);
  return ext ? ext : '.txt';
}

async function createTempFile(
  side: 'original' | 'proposed',
  targetPath: string,
  content: string,
): Promise<vscode.Uri> {
  const dir = await ensureStorageDir();
  const ext = resolveTempExtension(targetPath);
  const fileName = `${randomUUID()}-${side}${ext}`;
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, content, 'utf8');
  return vscode.Uri.file(filePath);
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
  } catch {
    return fallback;
  }
}

function enableSessionApprovalBypass(): void {
  approvalsBypassedForSession = true;
  void notifyProgressViewApprovalBypassState();
}

export function setToolEditApprovalSessionBypass(enabled: boolean): void {
  approvalsBypassedForSession = enabled;
  void notifyProgressViewApprovalBypassState();
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
  const baseDir = context.globalStorageUri ?? context.storageUri;
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

function createApprovalRequestId(): string {
  approvalCounter += 1;
  return `approval-${Date.now().toString(36)}-${approvalCounter}`;
}

async function showProgressViewApprovalPrompt(
  requestId: string,
  request: ToolEditApprovalRequest,
  relativePath: string,
): Promise<void> {
  await safeExecuteCommand('texra.showProgressView');

  try {
    const { ProgressViewProvider } = await import(
      '@progressView/ProgressViewProvider'
    );
    const provider = ProgressViewProvider.getInstance();
    provider?.showToolEditApprovalPrompt({
      requestId,
      path: request.path,
      relativePath,
      sourceTool: request.sourceTool,
      allowBypass: !approvalsBypassedForSession,
      streamId: request.streamId ?? '',
    });
  } catch (error) {
    console.warn('Unable to show progress view approval prompt', error);
  }
}

async function resolveProgressViewApprovalPrompt(
  requestId: string,
): Promise<void> {
  try {
    const { ProgressViewProvider } = await import(
      '@progressView/ProgressViewProvider'
    );
    ProgressViewProvider.getInstance()?.resolveToolEditApprovalPrompt(
      requestId,
    );
  } catch (error) {
    console.warn('Unable to resolve progress view approval prompt', error);
  }
}

function countNewlines(value: string): number {
  return (value.match(/\n/g) ?? []).length;
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

function computeUserPatch(
  suggestedContent: string,
  appliedContent: string,
): string | undefined {
  if (suggestedContent === appliedContent) {
    return undefined;
  }

  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(suggestedContent, appliedContent);
  const text = dmp.patch_toText(patches);
  return text.trim().length > 0 ? text : undefined;
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

async function nativeRequestApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  if (!initialized) {
    throw new Error('Tool edit approval has not been initialized.');
  }

  const { path, originalContent, proposedContent, sourceTool, streamId } =
    request;

  const requestId = createApprovalRequestId();
  const originalUri = await createTempFile('original', path, originalContent);
  const proposedUri = await createTempFile('proposed', path, proposedContent);

  const description = vscode.workspace.asRelativePath(
    WorkspaceFS.fullPath(path),
  );

  const title = `Tool edit (${sourceTool}): ${description}`;
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
        isSettled: () => settled,
        settle,
      };

      pendingApprovals.set(requestId, entry);
      void showProgressViewApprovalPrompt(requestId, request, description);
    });

    if (result.accepted) {
      const appliedContent = await readCurrentContent(
        proposedUri,
        proposedContent,
      );
      const userPatch = computeUserPatch(proposedContent, appliedContent);
      result = {
        ...result,
        appliedContent,
        userPatch,
      };
    }

    return result;
  } finally {
    pendingApprovals.delete(requestId);
    await closeApprovalEditors(originalUri, proposedUri);
    await fs.unlink(originalUri.fsPath).catch(() => {});
    await fs.unlink(proposedUri.fsPath).catch(() => {});
    await resolveProgressViewApprovalPrompt(requestId);
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

  const context = getCurrentToolEditApprovalContext();
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
    return { ...result };
  }

  const appliedContent = result.appliedContent ?? request.proposedContent;
  const userPatch =
    result.userPatch !== undefined
      ? result.userPatch
      : computeUserPatch(request.proposedContent, appliedContent);

  return {
    ...result,
    appliedContent,
    userPatch,
  };
}

export function getApprovedContent(
  approval: ToolEditApprovalResult,
  fallback: string,
): string {
  return approval.appliedContent ?? fallback;
}

export function formatApprovalUserDiff(
  path: string,
  userPatch?: string,
): string | undefined {
  if (!userPatch || userPatch.trim().length === 0) {
    return undefined;
  }

  return `User adjustments to ${path}:\n${userPatch}`;
}

export async function writeApprovedContent(
  path: string,
  originalContent: string,
  finalContent: string,
): Promise<string> {
  const exists = await WorkspaceFS.exists(path);
  if (!exists) {
    await WorkspaceFS.write(path, finalContent);
    return finalContent;
  }

  const currentContent = await WorkspaceFS.read(path);
  if (currentContent === finalContent) {
    return finalContent;
  }

  if (currentContent === originalContent) {
    await WorkspaceFS.write(path, finalContent);
    return finalContent;
  }

  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(originalContent, finalContent);
  const [patchedContent, results] = dmp.patch_apply(patches, currentContent);

  if (results.every(Boolean)) {
    await WorkspaceFS.write(path, patchedContent);
    return patchedContent;
  }

  await WorkspaceFS.write(path, finalContent);
  return finalContent;
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

  if (entry.isSettled()) {
    return;
  }

  if (payload.action === 'approve') {
    entry.settle({ accepted: true });
    return;
  }

  if (payload.action === 'approveAll') {
    enableSessionApprovalBypass();
    entry.settle({ accepted: true });
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
      userMessage = note?.trim();
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
  return toolResult({
    summary: baseMessage,
    error: userMessage ?? baseMessage,
    isError: true,
    output: userMessage,
  });
}
