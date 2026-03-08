/**
 * VS Code native implementation of the tool edit approval UI.
 *
 * This module contains all VS Code-coupled code that was extracted from
 * `@tools/approval/toolEditApproval` to keep that module platform-agnostic.
 *
 * The native handler opens a diff editor, manages temp files, and handles
 * approval/rejection via the progress view.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

import { isLatexFile } from '@common/files/fileTypeUtils';
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';
import type { LineChanges } from '@tools/result';
import {
  type LatexPreviewEntry,
  previewProposedLatex,
  runLatexdiff,
} from '@tools/approval/latexPreview';
import {
  computeLineChangeSummary,
  computeUserPatch,
  firstChangedLine,
  isApprovalBypassedForStream,
  markToolEditApprovalInitialized,
  registerPendingApproval,
  REVEAL_TIMEOUT_MS,
  setToolEditApprovalHandler,
  unregisterPendingApproval,
  type ToolEditApprovalAction,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files';
import { normalizeLineEndings } from '@utils/text/stringUtils';

interface PendingApprovalEntry extends LatexPreviewEntry {
  request: ToolEditApprovalRequest;
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
  title: string;
  streamId?: StreamTabId;
  lineChanges: LineChanges;
  settle: (result: ToolEditApprovalResult) => void;
}

interface ToolEditApprovalActionPayload {
  requestId: string;
  action: ToolEditApprovalAction;
  feedback?: string;
}

let approvalCounter = 0;
const pendingApprovals = new Map<string, PendingApprovalEntry>();
let storageDirectory: string | undefined;

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
  return vscode.Uri.file(filePath);
}

async function cleanupTempFile(uri: vscode.Uri): Promise<void> {
  await fs.unlink(uri.fsPath).catch(() => {});
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

async function showProgressViewApprovalPrompt(
  requestId: string,
  request: ToolEditApprovalRequest,
  relativePath: string,
  lineChanges: LineChanges,
): Promise<void> {
  // Best-effort: don't let a command failure prevent the approval prompt
  await Promise.resolve(
    vscode.commands.executeCommand('texra.showProgressView'),
  ).catch(() => {});
  const streamId = request.streamId;

  // Activate the stream that needs approval so user sees the prompt immediately
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
  });
}

function resolveProgressViewApprovalPrompt(requestId: string): void {
  bus.emit('resolveToolEditPermission', { requestId });
}

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

  approvalCounter += 1;
  const requestId = `approval-${Date.now().toString(36)}-${approvalCounter}`;
  const originalUri = await createTempFile('original', filePath, originalContent);
  const proposedUri = await createTempFile('proposed', filePath, proposedContent);

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
        onError: (msg) => vscode.window.showErrorMessage(msg),
      };

      pendingApprovals.set(requestId, entry);
      // Register with the pure module for rejection tracking
      registerPendingApproval(requestId, {
        streamId,
        isSettled: () => settled,
        settle,
      });
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
      // Normalize here: these reads bypass BaseFS so may contain CRLF.
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
    // Get entry before deleting to access workspace temp cleanup functions
    const entry = pendingApprovals.get(requestId);
    pendingApprovals.delete(requestId);
    unregisterPendingApproval(requestId);
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
        { preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
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
      // Normalize: this read bypasses BaseFS so may contain CRLF.
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

/**
 * Initialize the native VS Code tool edit approval handler.
 * Sets up storage directory and registers the native approval handler.
 */
export function initializeNativeToolEditApproval(
  context: vscode.ExtensionContext,
): void {
  const baseDir = context.storageUri ?? context.globalStorageUri;
  storageDirectory = path.join(baseDir.fsPath, 'tool-edit-previews');
  markToolEditApprovalInitialized();
  setToolEditApprovalHandler(nativeRequestApproval);
}
