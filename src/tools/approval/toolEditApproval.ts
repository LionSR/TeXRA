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

import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { isLatexFile } from '@common/files/fileTypeUtils';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { type LineChanges, type ToolResult } from '@tools/result';
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';
import { countLines } from '@utils/text/stringUtils';
import { bus } from '@eventBus/ProgressEventBus';

import { rejectPendingEntries } from './bashApproval';
import {
  type LatexPreviewEntry,
  previewProposedLatex,
  runLatexdiff,
} from './latexPreview';
import type { StreamTabId } from '@shared/schemas';

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

interface PendingApprovalEntry extends LatexPreviewEntry {
  request: ToolEditApprovalRequest;
  title: string;
  streamId?: StreamTabId;
  lineChanges: LineChanges;
  settle: (result: ToolEditApprovalResult) => void;
}

export const TOOL_EDIT_APPROVAL_ACTIONS = [
  'approve',
  'reject',
  'openDiff',
  'showLatexdiff',
  'previewProposed',
] as const;

export type ToolEditApprovalAction =
  (typeof TOOL_EDIT_APPROVAL_ACTIONS)[number];

interface ToolEditApprovalActionPayload {
  requestId: string;
  action: ToolEditApprovalAction;
  feedback?: string;
}

let queue: Promise<void> = Promise.resolve();
let initialized = false;
let customHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;
let approvalCounter = 0;
const pendingApprovals = new Map<string, PendingApprovalEntry>();
const approvalsBypassedByStream = new Map<StreamTabId, boolean>();
let storageDirectory: string | undefined;
const activePreviewFiles = new Set<string>();

function notifyApprovalBypassState(streamId: StreamTabId): void {
  if (!initialized) {
    return;
  }
  const bypassActive = approvalsBypassedByStream.get(streamId) ?? false;
  bus.emit('updateToolEditApprovalBypassState', {
    streamId,
    bypassActive,
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

export function setToolEditApprovalSessionBypass(
  streamId: StreamTabId,
  enabled: boolean,
): void {
  approvalsBypassedByStream.set(streamId, enabled);
  notifyApprovalBypassState(streamId);
}

export function toggleToolEditApprovalSessionBypass(
  streamId: StreamTabId,
): boolean {
  const currentState = approvalsBypassedByStream.get(streamId) ?? false;
  const newState = !currentState;
  setToolEditApprovalSessionBypass(streamId, newState);
  return newState;
}

export function isApprovalBypassedForStream(streamId: StreamTabId): boolean {
  return approvalsBypassedByStream.get(streamId) ?? false;
}

/** @internal Called by unified cleanup in index.ts */
export function _rejectPendingToolEditApprovalsForStream(
  streamId: StreamTabId,
): void {
  rejectPendingEntries(pendingApprovals.values(), streamId);
}

/** @internal Called by unified cleanup in index.ts */
export function _rejectAllPendingToolEditApprovals(): void {
  rejectPendingEntries(pendingApprovals.values());
}

/** @internal Called by unified cleanup in index.ts */
export function _clearApprovalBypassForStream(streamId: StreamTabId): void {
  approvalsBypassedByStream.delete(streamId);
}

/** @internal Called by unified cleanup in index.ts */
export function _clearAllApprovalBypass(): void {
  approvalsBypassedByStream.clear();
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
  const streamId = request.streamId;
  const isBypassed = streamId ? isApprovalBypassedForStream(streamId) : false;
  bus.emit('showToolEditPermission', {
    requestId,
    path: request.path,
    relativePath,
    sourceTool: request.sourceTool,
    allowBypass: !isBypassed,
    streamId: streamId ?? '',
    addedLines: lineChanges.added,
    removedLines: lineChanges.removed,
    isLatex: isLatexFile(request.path),
  });
}

function resolveProgressViewApprovalPrompt(requestId: string): void {
  bus.emit('resolveToolEditPermission', { requestId });
}

function createSemanticDiffs(
  original: string,
  proposed: string,
): ReturnType<InstanceType<typeof diff_match_patch>['diff_main']> {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, proposed);
  dmp.diff_cleanupSemantic(diffs);
  return diffs;
}

function computeLineChangeSummary(
  original: string,
  proposed: string,
): LineChanges {
  if (original === proposed) {
    return { added: 0, removed: 0 };
  }

  const diffs = createSemanticDiffs(original, proposed);

  let added = 0;
  let removed = 0;

  for (const [type, text] of diffs) {
    if (type === DIFF_INSERT) {
      added += countLines(text);
    } else if (type === DIFF_DELETE) {
      removed += countLines(text);
    }
  }

  return { added, removed };
}

function firstChangedLine(original: string, proposed: string): number | null {
  if (original === proposed) {
    return null;
  }

  const diffs = createSemanticDiffs(original, proposed);
  let proposedLine = 0;

  for (const [type, text] of diffs) {
    switch (type) {
      case DIFF_EQUAL:
        proposedLine += (text.match(/\n/g) ?? []).length;
        break;
      case DIFF_INSERT:
        return proposedLine;
      case DIFF_DELETE:
        return Math.max(proposedLine - 1, 0);
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

  if (patches.length === 0) {
    return undefined;
  }

  return dmp.patch_toText(patches);
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
  const { added, removed } = lineChanges;
  const totalChanged = added + removed;
  const changeParts = [
    added > 0 && `+${added}`,
    removed > 0 && `-${removed}`,
  ].filter(Boolean);
  const lineWord = totalChanged === 1 ? 'line' : 'lines';
  const changeSuffix = changeParts.length
    ? ` · ${changeParts.join(' / ')} ${lineWord}`
    : '';
  const title = `Tool edit (${sourceTool}): ${description}${changeSuffix}`;
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
        // Note: Don't delete from pendingApprovals here - finally block handles cleanup
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
        latexOperationInProgress: false,
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
      // Read current content from open document or file, falling back to proposedContent
      const openDocument = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.toString() === proposedUri.toString(),
      );
      const appliedContent = openDocument
        ? openDocument.getText()
        : await fs
            .readFile(proposedUri.fsPath, 'utf8')
            .catch(() => proposedContent);
      const userPatch = computeUserPatch(proposedContent, appliedContent);
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

    // Clean up any workspace temp files created by preview/latexdiff (parallel for performance)
    if (entry?.workspaceTempCleanup.length) {
      await Promise.all(
        entry.workspaceTempCleanup.map((fn) => fn().catch(() => {})),
      );
    }

    resolveProgressViewApprovalPrompt(requestId);
  }
}

async function enqueueApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  // Note: YOLO bypass is checked in requestToolEditApproval before enqueueing
  const run = async () =>
    customHandler ? customHandler(request) : nativeRequestApproval(request);

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

  // Check global config and per-stream YOLO mode
  const streamId = preparedRequest.streamId;
  const isStreamBypassed = streamId && isApprovalBypassedForStream(streamId);
  if (!approvalsEnabled || isStreamBypassed) {
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
    result.userPatch ??
    computeUserPatch(request.proposedContent, appliedContent);

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

export function formatUnifiedApprovalUserDiff(
  path: string,
  suggestedContent: string,
  appliedContent: string,
): string | undefined {
  const diffBody = computeUserPatch(suggestedContent, appliedContent);

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
  payload: ToolEditApprovalActionPayload,
): Promise<void> {
  const entry = pendingApprovals.get(payload.requestId);
  if (!entry || entry.isSettled()) {
    return;
  }

  switch (payload.action) {
    case 'openDiff':
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
      break;

    case 'showLatexdiff':
      // Use ONLYCHANGEDPAGE for tool edit approvals to focus on changes
      await runLatexdiff(entry, { subtype: 'ONLYCHANGEDPAGE' });
      break;

    case 'previewProposed':
      await previewProposedLatex(entry);
      break;

    case 'approve': {
      const appliedContent = await fs
        .readFile(entry.proposedUri.fsPath, 'utf-8')
        .catch(() => entry.proposedContent);
      entry.settle({ accepted: true, appliedContent });
      break;
    }

    case 'reject': {
      entry.settle({
        accepted: false,
        userMessage: payload.feedback?.trim() || undefined,
      });
      break;
    }
  }
}

export function buildApprovalRejectedResult(
  path: string,
  sourceTool: string,
  userMessage?: string,
): ToolResult {
  const baseMessage = `User rejected ${sourceTool} for ${path}.`;
  const feedback = userMessage?.trim();
  return {
    output: baseMessage,
    summary: baseMessage,
    error: baseMessage,
    isError: true,
    ...(feedback ? { userInstruction: feedback } : {}),
  };
}
