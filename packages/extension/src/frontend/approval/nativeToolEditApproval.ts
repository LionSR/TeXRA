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

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { isLatexFile } from '@common/files/fileTypeUtils';
import {
  type DiffSession,
  type DiffSource,
  type DiffViewHost,
} from '@frontend/approval/DiffViewHost';
import { VscodeDiffViewHost } from '@frontend/approval/VscodeDiffViewHost';
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
  registerPendingApproval,
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
  diffSession: DiffSession;
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
const diffViewHost: DiffViewHost = new VscodeDiffViewHost();
let storageDirectory: string | undefined;
let runtimeHost: AgentRuntimeHost | undefined;

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

async function createTempFile(
  side: 'original' | 'proposed',
  targetPath: string,
  content: string,
): Promise<DiffSource> {
  const dir = await ensureStorageDir();
  const ext = path.extname(targetPath) || '.txt';
  const fileName = `${randomUUID()}-${side}${ext}`;
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, content, 'utf8');
  return { filePath };
}

async function cleanupTempFile(source: DiffSource): Promise<void> {
  await fs.unlink(source.filePath).catch(() => {});
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
    getRuntimeHost().emit('setActiveStream', { streamId });
  }

  const isBypassed = streamId ? isApprovalBypassedForStream(streamId) : false;
  getRuntimeHost().emit('showToolEditPermission', {
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
  getRuntimeHost().emit('resolveToolEditPermission', { requestId });
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
  const originalSource = await createTempFile(
    'original',
    filePath,
    originalContent,
  );
  const proposedSource = await createTempFile(
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
  let diffSession: DiffSession | undefined;
  try {
    const openedSession = await diffViewHost.openDiff(
      originalSource,
      proposedSource,
      title,
      { preserveFocus: true },
    );
    diffSession = openedSession;

    await revealFirstChangedLine(
      openedSession,
      originalContent,
      proposedContent,
    );

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
        diffSession: openedSession,
        originalUri: { fsPath: originalSource.filePath },
        proposedUri: { fsPath: proposedSource.filePath },
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
    // Get entry before deleting to access workspace temp cleanup functions
    const entry = pendingApprovals.get(requestId);
    pendingApprovals.delete(requestId);
    unregisterPendingApproval(requestId);
    if (diffSession) {
      await diffViewHost.closeDiff(diffSession);
    }
    await cleanupTempFile(originalSource);
    await cleanupTempFile(proposedSource);

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
      await runLatexdiff(entry, { subtype: 'ONLYCHANGEDPAGE' });
      break;

    case 'previewProposed':
      await previewProposedLatex(entry);
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
): void {
  const baseDir = context.storageUri ?? context.globalStorageUri;
  storageDirectory = path.join(baseDir.fsPath, 'tool-edit-previews');
  runtimeHost = host;
  setToolEditApprovalHandler(nativeRequestApproval);
}
