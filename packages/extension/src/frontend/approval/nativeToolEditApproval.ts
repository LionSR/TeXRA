/**
 * VS Code native implementation of the tool edit approval UI.
 *
 * This module contains the VS Code-coupled approval surface. The runtime
 * boundary keeps the core tool-edit approval module platform-agnostic.
 *
 * The native handler opens a diff editor, manages temp files, and handles
 * approval/rejection via the progress view.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  setRuntimeToolEditApprovalHandler,
  startRuntimeToolEditApprovalPrompt,
  type RuntimeToolEditApprovalRequest,
  type RuntimeToolEditApprovalResult,
  type RuntimeToolEditApprovalPromptSession,
} from '@agent/runtime/approvalCommands';
import { VscodeDiffViewHost } from '@frontend/approval/VscodeDiffViewHost';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  type DiffSession,
  type DiffSource,
  type DiffViewHost,
} from '@hosts/uiHosts';
import type { StreamTabId } from '@shared/schemas';
import type { LineChanges } from '@shared/schemas/lineChanges';
import type { ToolEditApprovalAction } from '@shared/schemas/prompts';
import {
  computeLineChangeSummary,
  computeUserPatch,
  firstChangedLine,
} from '@shared/approval/toolEditDiff';
import { writeApprovalTempFiles } from '@shared/approval/tempFileManager';
import {
  type BuildDisplayFn,
  type LatexPreviewEntry,
  previewProposedLatex,
  runLatexdiff,
} from '@tools/approval/latexPreview';
import { WorkspaceFS } from '@utils/files';
import { normalizeLineEndings } from '@utils/text/stringUtils';

interface PendingApprovalEntry extends LatexPreviewEntry {
  request: RuntimeToolEditApprovalRequest;
  diffSession: DiffSession;
  title: string;
  streamId?: StreamTabId;
  lineChanges: LineChanges;
  settle: (result: RuntimeToolEditApprovalResult) => void;
}

interface ToolEditApprovalActionPayload {
  requestId: string;
  action: ToolEditApprovalAction;
  feedback?: string;
}

let approvalCounter = 0;
const pendingApprovals = new Map<string, PendingApprovalEntry>();
const diffViewHost: DiffViewHost = new VscodeDiffViewHost();
let storageDirectory: string | undefined;
let runtimeHost: AgentRuntimeHost | undefined;
let openBuildDisplay: BuildDisplayFn | undefined;

function getStorageDir(): string {
  if (!storageDirectory) {
    throw new Error('Tool edit approval has not been initialized.');
  }
  return storageDirectory;
}

function getRuntimeHost(): AgentRuntimeHost {
  if (!runtimeHost) {
    throw new Error(
      'Tool edit approval runtime host has not been initialized.',
    );
  }
  return runtimeHost;
}

async function ensureStorageDir(): Promise<string> {
  const dir = getStorageDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function revealFirstChangedLine(
  session: DiffSession,
  originalContent: string,
  proposedContent: string,
): Promise<void> {
  const line = firstChangedLine(originalContent, proposedContent);
  if (line === null) {
    return;
  }

  await diffViewHost.revealFirstChange(session, line);
}

async function showProgressViewApprovalPrompt(
  promptSession: RuntimeToolEditApprovalPromptSession,
  relativePath: string,
  lineChanges: LineChanges,
): Promise<void> {
  // Best-effort: don't let a command failure prevent the approval prompt
  await Promise.resolve(
    vscode.commands.executeCommand('texra.showProgressView'),
  ).catch(() => {});

  promptSession.emitPrompt({
    relativePath,
    lineChanges,
  });
}

async function nativeRequestApproval(
  request: RuntimeToolEditApprovalRequest,
): Promise<RuntimeToolEditApprovalResult> {
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
  const directory = await ensureStorageDir();
  const {
    originalPath,
    proposedPath,
    cleanup: cleanupApprovalSources,
  } = await writeApprovalTempFiles({
    directory,
    targetPath: filePath,
    originalContent,
    proposedContent,
  });
  const originalSource: DiffSource = { filePath: originalPath };
  const proposedSource: DiffSource = { filePath: proposedPath };

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
  let result: RuntimeToolEditApprovalResult = { accepted: false };
  let diffSession: DiffSession | undefined;
  let tabCloseDisposable: vscode.Disposable | undefined;
  let runtimePrompt: RuntimeToolEditApprovalPromptSession | undefined;
  try {
    const openedSession = await diffViewHost.openDiff(
      originalSource,
      proposedSource,
      title,
      { preserveFocus: true },
    );
    diffSession = openedSession;

    let approvalSettled = false;
    const approvalPromise = new Promise<RuntimeToolEditApprovalResult>(
      (resolve) => {
        const settle = (value: RuntimeToolEditApprovalResult) => {
          if (approvalSettled) {
            return;
          }
          approvalSettled = true;
          // Note: Don't delete from pendingApprovals here - finally block handles cleanup
          resolve(value);
        };

        const entry: PendingApprovalEntry = {
          request,
          diffSession: openedSession,
          originalUri: { fsPath: originalSource.filePath },
          proposedUri: { fsPath: proposedSource.filePath },
          originalContent,
          proposedContent,
          title,
          streamId: streamId ?? undefined,
          lineChanges,
          isSettled: () => approvalSettled,
          settle,
          workspaceTempCleanup: [],
          latexOperationInProgress: false,
          onError: (msg) => vscode.window.showErrorMessage(msg),
        };

        pendingApprovals.set(requestId, entry);
        const host = getRuntimeHost();
        runtimePrompt = startRuntimeToolEditApprovalPrompt({
          requestId,
          request,
          runtimeHost: host,
          pending: {
            streamId: streamId ?? undefined,
            runtimeHost: host,
            isSettled: () => approvalSettled,
            settle,
          },
        });

        // Closing the proposed diff tab (e.g. Ctrl+W) must resolve the approval
        // as a rejection. Without this the approval Promise would never settle
        // and the agent would hang indefinitely. The listener is self-cleaning:
        // it disposes once the approval settles (including the programmatic
        // close in the `finally` block below).
        const proposedUriStr = vscode.Uri.file(
          proposedSource.filePath,
        ).toString();
        tabCloseDisposable = vscode.window.tabGroups.onDidChangeTabs(
          (event) => {
            if (approvalSettled) {
              tabCloseDisposable?.dispose();
              return;
            }
            const wasClosed = event.closed.some((tab) => {
              const input = tab.input;
              if (
                typeof vscode.TabInputTextDiff !== 'undefined' &&
                input instanceof vscode.TabInputTextDiff
              ) {
                return input.modified.toString() === proposedUriStr;
              }
              if (
                typeof vscode.TabInputText !== 'undefined' &&
                input instanceof vscode.TabInputText
              ) {
                return input.uri.toString() === proposedUriStr;
              }
              return false;
            });
            if (wasClosed) {
              tabCloseDisposable?.dispose();
              settle({ accepted: false });
            }
          },
        );
      },
    );

    try {
      await revealFirstChangedLine(
        openedSession,
        originalContent,
        proposedContent,
      );
    } catch (err) {
      if (!approvalSettled) {
        throw err;
      }
    }

    if (!approvalSettled && runtimePrompt) {
      void showProgressViewApprovalPrompt(
        runtimePrompt,
        description,
        lineChanges,
      );
    }

    result = await approvalPromise;

    if (result.accepted) {
      // Normalize here: these reads bypass BaseFS so may contain CRLF.
      const appliedContent = normalizeLineEndings(
        await diffViewHost.readProposedContent(openedSession, proposedContent),
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
    // Stop listening for tab closes before we programmatically close the diff.
    tabCloseDisposable?.dispose();
    // Get entry before deleting to access workspace temp cleanup functions
    const entry = pendingApprovals.get(requestId);
    pendingApprovals.delete(requestId);
    runtimePrompt?.complete();
    if (diffSession) {
      await diffViewHost.closeDiff(diffSession);
    }
    await cleanupApprovalSources();

    // Clean up any workspace temp files created by preview/latexdiff (parallel for performance)
    if (entry?.workspaceTempCleanup.length) {
      await Promise.all(
        entry.workspaceTempCleanup.map((fn) => fn().catch(() => {})),
      );
    }
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
      entry.diffSession = await diffViewHost.openDiff(
        entry.diffSession.original,
        entry.diffSession.proposed,
        entry.title,
        { preserveFocus: true },
      );
      await revealFirstChangedLine(
        entry.diffSession,
        entry.originalContent,
        entry.proposedContent,
      );
      break;

    case 'showLatexdiff':
      // Use ONLYCHANGEDPAGE for tool edit approvals to focus on changes
      await runLatexdiff(entry, {
        subtype: 'ONLYCHANGEDPAGE',
        openBuildDisplay,
      });
      break;

    case 'previewProposed':
      await previewProposedLatex(entry, { openBuildDisplay });
      break;

    case 'approve': {
      // Normalize: this read bypasses BaseFS so may contain CRLF.
      const appliedContent = normalizeLineEndings(
        await diffViewHost.readProposedContent(
          entry.diffSession,
          entry.proposedContent,
        ),
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
  host: AgentRuntimeHost,
  buildDisplay: BuildDisplayFn,
): void {
  const baseDir = context.storageUri ?? context.globalStorageUri;
  storageDirectory = path.join(baseDir.fsPath, 'tool-edit-previews');
  runtimeHost = host;
  openBuildDisplay = buildDisplay;
  setRuntimeToolEditApprovalHandler(nativeRequestApproval);
}
