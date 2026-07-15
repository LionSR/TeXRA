/**
 * VS Code native implementation of the tool edit approval UI.
 *
 * This module contains all VS Code-coupled code that was extracted from
 * `@tools/approval/toolEditApproval` to keep that module platform-agnostic.
 *
 * The native handler opens a diff editor, manages temp files, and handles
 * approval/rejection via the progress view.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { nanoid } from 'nanoid';
import * as vscode from 'vscode';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  matchesCancelSelector,
  type HostInteractionCancelSelector,
} from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { VscodeDiffViewHost } from '@frontend/approval/VscodeDiffViewHost';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import {
  type DiffSession,
  type DiffSource,
  type DiffViewHost,
} from '@hosts/uiHosts';
import type { StreamTabId } from '@shared/schemas';
import type { LineChanges } from '@shared/schemas/lineChanges';
import type { ToolEditApprovalAction } from '@shared/schemas/prompts';
import {
  type LatexPreviewEntry,
  previewProposedLatex,
  runLatexdiff,
} from '@tools/approval/latexPreview';
import { writeApprovalTempFiles } from '@tools/approval/tempFileManager';
import {
  computeLineChangeSummary,
  computeUserPatch,
  emitToolEditApprovalPrompt,
  firstChangedLine,
  registerPendingApproval,
  unregisterPendingApproval,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings, pluralize } from '@utils/text/stringUtils';

const CHANNEL = 'nativeToolEditApproval';

interface PendingApprovalEntry extends LatexPreviewEntry {
  request: ToolEditApprovalRequest;
  session: SessionHandle;
  diffSession: DiffSession;
  title: string;
  relativePath: string;
  streamId?: StreamTabId;
  lineChanges: LineChanges;
  settle: (result: ToolEditApprovalResult) => void;
  cancellationScope?: object;
}

interface InitializingNativeApproval {
  readonly request: ToolEditApprovalRequest;
  readonly session: SessionHandle;
  readonly cancellationScope?: object;
  earlyResolution?: ToolEditApprovalResult;
}

interface ToolEditApprovalActionPayload {
  requestId: string;
  action: ToolEditApprovalAction;
  feedback?: string;
}

const pendingApprovals = new Map<string, PendingApprovalEntry>();
const initializingApprovals = new Map<string, InitializingNativeApproval>();
const diffViewHost: DiffViewHost = new VscodeDiffViewHost();
let storageDirectory: string | undefined;
let runtimeHost: AgentRuntimeHost | undefined;

/** Reject native approvals owned by one session and selected interaction scope. */
export function cancelNativeToolEditApprovals(
  session: SessionHandle,
  selector: HostInteractionCancelSelector = {},
): void {
  for (const initialization of initializingApprovals.values()) {
    if (
      initialization.session !== session ||
      initialization.earlyResolution ||
      !matchesCancelSelector(
        {
          kind: 'toolEdit',
          streamId: initialization.request.streamId ?? undefined,
          cancellationScope: initialization.cancellationScope,
        },
        selector,
      )
    ) {
      continue;
    }
    initialization.earlyResolution = {
      accepted: false,
      userMessage: selector.cause,
    };
  }
  for (const entry of pendingApprovals.values()) {
    if (
      entry.session !== session ||
      !matchesCancelSelector(
        {
          kind: 'toolEdit',
          streamId: entry.streamId,
          cancellationScope: entry.cancellationScope,
        },
        selector,
      )
    ) {
      continue;
    }
    entry.settle({ accepted: false, userMessage: selector.cause });
  }
}

/** Approve native edit requests already pending for one session stream. */
export async function approveNativeToolEditApprovals(
  session: SessionHandle,
  streamId: StreamTabId,
): Promise<void> {
  for (const initialization of initializingApprovals.values()) {
    if (
      initialization.session !== session ||
      initialization.earlyResolution ||
      initialization.request.streamId !== streamId
    ) {
      continue;
    }
    initialization.earlyResolution = {
      accepted: true,
      appliedContent: initialization.request.proposedContent,
    };
  }

  const requestIds = [...pendingApprovals]
    .filter(
      ([, entry]) =>
        entry.session === session &&
        entry.streamId === streamId &&
        !entry.isSettled(),
    )
    .map(([requestId]) => requestId);
  await Promise.all(
    requestIds.map((requestId) =>
      handleProgressViewToolEditApprovalAction({
        requestId,
        action: 'approve',
      }),
    ),
  );
}

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
  session: SessionHandle,
  requestId: string,
  request: ToolEditApprovalRequest,
  relativePath: string,
  lineChanges: LineChanges,
): Promise<void> {
  // Best-effort: don't let a command failure prevent the approval prompt
  await Promise.resolve(
    vscode.commands.executeCommand('texra.showProgressView'),
  ).catch(() => {});

  const entry = pendingApprovals.get(requestId);
  if (!entry || entry.session !== session || entry.isSettled()) return;

  publishProgressViewApprovalPrompt(
    session,
    requestId,
    request,
    relativePath,
    lineChanges,
  );
}

function publishProgressViewApprovalPrompt(
  session: SessionHandle,
  requestId: string,
  request: ToolEditApprovalRequest,
  relativePath: string,
  lineChanges: LineChanges,
): void {
  // Activate the stream that needs approval and post the prompt (shared with
  // the desktop host); VS Code computes the relative path via the workspace.
  emitToolEditApprovalPrompt(getRuntimeHost(), session, {
    requestId,
    request,
    relativePath,
    lineChanges,
  });
}

function resolveProgressViewApprovalPrompt(requestId: string): void {
  getRuntimeHost().emit('resolveToolEditPermission', { requestId });
}

function restoreProgressViewApprovalPrompt(
  requestId: string,
  entry: PendingApprovalEntry,
): void {
  // The frontend removes the panel optimistically on approve. Reset backend
  // delivery tracking, then publish the still-pending request under the same ID.
  resolveProgressViewApprovalPrompt(requestId);
  publishProgressViewApprovalPrompt(
    entry.session,
    requestId,
    entry.request,
    entry.relativePath,
    entry.lineChanges,
  );
}

export async function nativeRequestApproval(
  request: ToolEditApprovalRequest,
  options: { session: SessionHandle; cancellationScope?: object },
): Promise<ToolEditApprovalResult> {
  getStorageDir(); // Validates initialization

  const {
    path: filePath,
    originalContent,
    proposedContent,
    sourceTool,
    streamId,
  } = request;

  const requestId = `approval-${nanoid()}`;
  const lineChanges = computeLineChangeSummary(
    originalContent,
    proposedContent,
  );
  const initialization: InitializingNativeApproval = {
    request,
    session: options.session,
    cancellationScope: options.cancellationScope,
  };
  initializingApprovals.set(requestId, initialization);
  let approvalSources: Awaited<ReturnType<typeof writeApprovalTempFiles>>;
  try {
    const directory = await ensureStorageDir();
    approvalSources = await writeApprovalTempFiles({
      directory,
      targetPath: filePath,
      originalContent,
      proposedContent,
    });
  } catch (error) {
    initializingApprovals.delete(requestId);
    throw error;
  }
  const {
    originalPath,
    proposedPath,
    cleanup: cleanupApprovalSources,
  } = approvalSources;
  if (initialization.earlyResolution) {
    initializingApprovals.delete(requestId);
    await cleanupApprovalSources();
    return {
      ...initialization.earlyResolution,
      lineChanges: initialization.earlyResolution.lineChanges ?? lineChanges,
    };
  }
  const originalSource: DiffSource = { filePath: originalPath };
  const proposedSource: DiffSource = { filePath: proposedPath };

  const description = vscode.workspace.asRelativePath(
    WorkspaceFS.fullPath(filePath),
  );
  const { added, removed } = lineChanges;
  const totalChanged = added + removed;
  const changeParts = [
    added > 0 && `+${added}`,
    removed > 0 && `-${removed}`,
  ].filter(Boolean);
  const lineWord = pluralize(totalChanged, 'line');
  const changeSuffix = changeParts.length
    ? ` · ${changeParts.join(' / ')} ${lineWord}`
    : '';
  const title = `Tool edit (${sourceTool}): ${description}${changeSuffix}`;
  let result: ToolEditApprovalResult = { accepted: false };
  let diffSession: DiffSession | undefined;
  let tabCloseDisposable: vscode.Disposable | undefined;
  try {
    const openedSession = await diffViewHost.openDiff(
      originalSource,
      proposedSource,
      title,
      { preserveFocus: true },
    );
    diffSession = openedSession;

    if (initialization.earlyResolution) {
      result = initialization.earlyResolution;
      return {
        ...result,
        lineChanges: result.lineChanges ?? lineChanges,
      };
    }

    let approvalSettled = false;
    const approvalPromise = new Promise<ToolEditApprovalResult>((resolve) => {
      const settle = (value: ToolEditApprovalResult) => {
        if (approvalSettled) {
          return;
        }
        approvalSettled = true;
        // Note: Don't delete from pendingApprovals here - finally block handles cleanup
        resolve(value);
      };

      const entry: PendingApprovalEntry = {
        request,
        session: options.session,
        diffSession: openedSession,
        originalUri: { fsPath: originalSource.filePath },
        proposedUri: { fsPath: proposedSource.filePath },
        originalContent,
        proposedContent,
        title,
        relativePath: description,
        streamId: streamId ?? undefined,
        lineChanges,
        cancellationScope: initialization.cancellationScope,
        isSettled: () => approvalSettled,
        settle,
        workspaceTempCleanup: [],
        latexOperationInProgress: false,
        onError: (msg) => void showLoggedMessage(CHANNEL, msg),
      };

      pendingApprovals.set(requestId, entry);
      initializingApprovals.delete(requestId);
      // Register with the owning session's registry for rejection tracking
      registerPendingApproval(
        requestId,
        {
          streamId: streamId ?? undefined,
          isSettled: () => approvalSettled,
          settle,
        },
        options.session,
      );

      // Closing the proposed diff tab (e.g. Ctrl+W) must resolve the approval
      // as a rejection. Without this the approval Promise would never settle
      // and the agent would hang indefinitely. The listener is self-cleaning:
      // it disposes once the approval settles (including the programmatic
      // close in the `finally` block below).
      const proposedUriStr = vscode.Uri.file(
        proposedSource.filePath,
      ).toString();
      tabCloseDisposable = vscode.window.tabGroups.onDidChangeTabs((event) => {
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
      });
    });

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

    if (!approvalSettled) {
      void showProgressViewApprovalPrompt(
        options.session,
        requestId,
        request,
        description,
        lineChanges,
      );
    }

    result = await approvalPromise;

    if (result.accepted) {
      const appliedContent = result.appliedContent;
      if (appliedContent == null) {
        throw new Error(
          'Tool edit approval settled without the current proposed content.',
        );
      }
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
    initializingApprovals.delete(requestId);
    // Stop listening for tab closes before we programmatically close the diff.
    tabCloseDisposable?.dispose();
    // Get entry before deleting to access workspace temp cleanup functions
    const entry = pendingApprovals.get(requestId);
    pendingApprovals.delete(requestId);
    unregisterPendingApproval(requestId, options.session);
    const currentDiffSession = entry?.diffSession ?? diffSession;
    if (currentDiffSession) {
      await diffViewHost.closeDiff(currentDiffSession);
    }
    await cleanupApprovalSources();

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
    case 'openDiff': {
      const reopenedSession = await diffViewHost.openDiff(
        entry.diffSession.original,
        entry.diffSession.proposed,
        entry.title,
        { preserveFocus: true },
      );
      if (
        entry.isSettled() ||
        pendingApprovals.get(payload.requestId) !== entry
      ) {
        await diffViewHost.closeDiff(reopenedSession);
        return;
      }
      entry.diffSession = reopenedSession;
      await revealFirstChangedLine(
        entry.diffSession,
        entry.originalContent,
        entry.proposedContent,
      );
      break;
    }

    case 'showLatexdiff':
      // Use ONLYCHANGEDPAGE for tool edit approvals to focus on changes
      await runLatexdiff(entry, { subtype: 'ONLYCHANGEDPAGE' });
      break;

    case 'previewProposed':
      await previewProposedLatex(entry);
      break;

    case 'approve': {
      try {
        // Normalize: this read bypasses BaseFS so may contain CRLF.
        const appliedContent = normalizeLineEndings(
          await diffViewHost.readProposedContent(entry.diffSession),
        );
        entry.settle({ accepted: true, appliedContent });
      } catch (error) {
        if (!entry.isSettled()) {
          entry.onError(
            `Approval failed because the edited document could not be read: ${toErrorMessage(error)}`,
          );
          restoreProgressViewApprovalPrompt(payload.requestId, entry);
        }
      }
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
 *
 * Sets up the storage directory and runtime host used by {@link nativeRequestApproval},
 * which is wired into the Platform at {@link initPlatform} time.  The wiring itself
 * lives in the extension's `initPlatform` call — this function only supplies the
 * module-level dependencies `nativeRequestApproval` closes over.
 */
export function initializeNativeToolEditApproval(
  context: vscode.ExtensionContext,
  host: AgentRuntimeHost,
): void {
  const baseDir = context.storageUri ?? context.globalStorageUri;
  storageDirectory = path.join(baseDir.fsPath, 'tool-edit-previews');
  runtimeHost = host;
}
