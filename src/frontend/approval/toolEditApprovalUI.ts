/**
 * VS Code UI layer for tool edit approvals.
 *
 * Provides the native VS Code diff-based approval flow and the progress view
 * action handler.  Keeps `@tools/approval/toolEditApproval` free of direct
 * `vscode` imports so it remains platform-agnostic.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

import * as vscode from 'vscode';

import { isLatexFile } from '@common/files/fileTypeUtils';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { WorkspaceFS } from '@utils/files';
import { normalizeLineEndings } from '@utils/text/stringUtils';
import { bus } from '@eventBus/ProgressEventBus';

import {
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
  type PendingApprovalEntry,
  type ToolEditApprovalAction,
  getPendingApproval,
  setPendingApproval,
  deletePendingApproval,
  trackPreviewFile,
  untrackPreviewFile,
  nextApprovalId,
  ensureStorageDir,
  getStorageDir,
  computeLineChangeSummary,
  firstChangedLine,
  computeUserPatch,
  resolveProgressViewApprovalPrompt,
  setToolEditApprovalHandler,
  initializeToolEditApprovalCore,
  isApprovalBypassedForStream,
} from '@tools/approval/toolEditApproval';

import {
  runLatexdiff,
  previewProposedLatex,
} from '@tools/approval/latexPreview';

import type { StreamTabId, ToolEditPermission } from '@shared/schemas';
import type { LineChanges } from '@tools/result';

const REVEAL_TIMEOUT_MS = 1500;

// ============================================================================
// Temp File Helpers
// ============================================================================

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
  trackPreviewFile(filePath);
  return vscode.Uri.file(filePath);
}

async function cleanupTempFile(uri: vscode.Uri): Promise<void> {
  untrackPreviewFile(uri.fsPath);
  await fs.unlink(uri.fsPath).catch(() => {});
}

// ============================================================================
// Editor Helpers
// ============================================================================

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

// ============================================================================
// Progress View Prompt
// ============================================================================

async function showProgressViewApprovalPrompt(
  requestId: string,
  request: ToolEditApprovalRequest,
  relativePath: string,
  lineChanges: LineChanges,
): Promise<void> {
  await safeExecuteCommand('texra.showProgressView');
  const streamId = request.streamId;

  if (streamId) {
    bus.emit('setActiveStream', { streamId });
  }

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
  } satisfies ToolEditPermission);
}

// ============================================================================
// Native Request Approval (VS Code diff-based)
// ============================================================================

async function nativeRequestApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  getStorageDir(); // Validates initialization

  const {
    path: filePath,
    originalContent,
    proposedContent,
    sourceTool,
    streamId,
  } = request;

  const requestId = nextApprovalId();
  const originalUri = await createTempFile(
    'original',
    filePath,
    originalContent,
  );
  const proposedUri = await createTempFile(
    'proposed',
    filePath,
    proposedContent,
  );

  const description = vscode.workspace.asRelativePath(
    WorkspaceFS.fullPath(filePath),
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
      { preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
    );

    await revealFirstChange(proposedUri, originalContent, proposedContent);

    result = await new Promise<ToolEditApprovalResult>((resolve) => {
      let settled = false;

      const settle = (value: ToolEditApprovalResult) => {
        if (settled) {
          return;
        }
        settled = true;
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
        onError: (msg: string) => vscode.window.showErrorMessage(msg),
      };

      setPendingApproval(requestId, entry);
      void showProgressViewApprovalPrompt(
        requestId,
        request,
        description,
        lineChanges,
      );
    });

    if (result.accepted) {
      const openDocument = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.toString() === proposedUri.toString(),
      );
      const appliedContent = normalizeLineEndings(
        openDocument
          ? openDocument.getText()
          : await fs
              .readFile(proposedUri.fsPath, 'utf8')
              .catch(() => proposedContent),
      );
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
    const entry = deletePendingApproval(requestId);
    await closeApprovalEditors(originalUri, proposedUri);
    await Promise.all([
      cleanupTempFile(originalUri),
      cleanupTempFile(proposedUri),
      ...(entry?.workspaceTempCleanup.map((fn) => fn().catch(() => {})) ?? []),
    ]);

    resolveProgressViewApprovalPrompt(requestId);
  }
}

// ============================================================================
// Progress View Action Handler
// ============================================================================

interface ToolEditApprovalActionPayload {
  requestId: string;
  action: ToolEditApprovalAction;
  feedback?: string;
}

export async function handleProgressViewToolEditApprovalAction(
  payload: ToolEditApprovalActionPayload,
): Promise<void> {
  const entry = getPendingApproval(payload.requestId);
  if (!entry || entry.isSettled()) {
    return;
  }

  switch (payload.action) {
    case 'openDiff': {
      const origUri = vscode.Uri.file(entry.originalUri.fsPath);
      const propUri = vscode.Uri.file(entry.proposedUri.fsPath);
      await vscode.commands.executeCommand(
        'vscode.diff',
        origUri,
        propUri,
        entry.title,
        { preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
      );
      await revealFirstChange(
        propUri,
        entry.originalContent,
        entry.proposedContent,
      );
      break;
    }

    case 'showLatexdiff':
      await runLatexdiff(entry, { subtype: 'ONLYCHANGEDPAGE' });
      break;

    case 'previewProposed':
      await previewProposedLatex(entry);
      break;

    case 'approve': {
      const appliedContent = normalizeLineEndings(
        await fs
          .readFile(entry.proposedUri.fsPath, 'utf-8')
          .catch(() => entry.proposedContent),
      );
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

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the tool edit approval system with VS Code context.
 * Sets up the storage directory and registers the native approval handler.
 */
export function initializeToolEditApproval(
  context: vscode.ExtensionContext,
): void {
  const baseDir = context.storageUri ?? context.globalStorageUri;
  const storagePath = path.join(baseDir.fsPath, 'tool-edit-previews');
  initializeToolEditApprovalCore(storagePath);
  setToolEditApprovalHandler(nativeRequestApproval);
}
