import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  getRunContextSession,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import {
  currentSession,
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { isLatexFile } from '@common/files/fileTypeUtils';
import type { StreamTabId } from '@shared/schemas';
import type { ToolEditApprovalAction } from '@shared/schemas/prompts';
import type { LineChanges } from '@shared/schemas/lineChanges';
import { type ToolResult } from '@shared/schemas/toolResult';
import { recordToolFileRead } from '@tools/fileInteractions';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config/configUtils';
import {
  applyPatchToText,
  diffTextByChar,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  makePatchText,
  type TextDiff,
} from '@utils/text/diff';
import { countLines } from '@utils/text/stringUtils';

import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces';

export type { ToolEditApprovalRequest, ToolEditApprovalResult };

const TOOL_EDIT_APPROVAL_CONFIG_KEY = 'texra.toolUse.requireEditApproval';

export const REVEAL_TIMEOUT_MS = 1500;

/** Register a pending approval entry for rejection tracking. */
export function registerPendingApproval(
  id: string,
  entry: {
    streamId?: StreamTabId;
    isSettled: () => boolean;
    settle: (result: ToolEditApprovalResult) => void;
  },
  session: SessionHandle = currentSession(),
): void {
  session.approvals.toolEdit.registerPending(id, entry);
}

/** Unregister a pending approval entry after it has been resolved. */
export function unregisterPendingApproval(
  id: string,
  session: SessionHandle = currentSession(),
): void {
  session.approvals.toolEdit.unregisterPending(id);
}

export function setToolEditApprovalSessionBypass(
  streamId: StreamTabId,
  enabled: boolean,
  runtimeHost: AgentRuntimeHost,
  options?: { silent?: boolean; session?: SessionHandle },
): void {
  (options?.session ?? currentSession()).approvals.toolEdit.bypass.setBypass(
    streamId,
    enabled,
    runtimeHost,
    options,
  );
}

/**
 * Flip the stream's tool-edit bypass. Retained as part of the symmetric
 * set/toggle/is bypass API (mirrors `toggleBashApprovalSessionBypass`) and
 * exercised by the approval-gate unit tests. It has no production caller today:
 * the shield toolbar toggle forces state via `setToolEditApprovalSessionBypass`
 * (see `applyCoupledBypass` in ProgressViewCommandHandlers).
 */
export function toggleToolEditApprovalSessionBypass(
  streamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
  session: SessionHandle = currentSession(),
): boolean {
  return session.approvals.toolEdit.bypass.toggleBypass(streamId, runtimeHost);
}

export function isApprovalBypassedForStream(
  streamId: StreamTabId,
  session: SessionHandle = currentSession(),
): boolean {
  return session.approvals.toolEdit.bypass.isBypassed(streamId);
}

/**
 * Emit the tool-edit approval prompt to the progress view: register the
 * stream awaiting input (without switching the active tab — the request
 * surfaces as a pending badge on the stream's row, #8246) and post the
 * `showToolEditPermission` event with the bypass affordance gated on the
 * stream's current bypass state.
 *
 * Shared host-agnostic logic for the VS Code (`nativeToolEditApproval`) and
 * desktop (`desktopToolEditApproval`) approval surfaces. Each host computes
 * `relativePath` in its own way and performs any host-specific routing (e.g.
 * revealing the progress view) around this call.
 */
export function emitToolEditApprovalPrompt(
  runtimeHost: AgentRuntimeHost,
  session: SessionHandle,
  params: {
    requestId: string;
    request: ToolEditApprovalRequest;
    relativePath: string;
    lineChanges: LineChanges;
  },
): void {
  const { requestId, request, relativePath, lineChanges } = params;
  const { streamId } = request;
  if (streamId) {
    runtimeHost.emit('requestEnsureProgressView', {});
    session.events.emit({
      scope: 'session',
      event: {
        type: 'setActiveStream',
        payload: {
          streamId,
          suppressViewSwitch: true,
          ensureVisible: true,
        },
      },
    });
  }
  const isBypassed = streamId
    ? session.approvals.toolEdit.bypass.isBypassed(streamId)
    : false;
  runtimeHost.emit('showToolEditPermission', {
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

// ============================================================================
// Pure diff helpers (exported for use by native handler in @frontend/)
// ============================================================================

function createSemanticDiffs(original: string, proposed: string): TextDiff[] {
  return diffTextByChar(original, proposed, {
    checkLines: true,
    cleanupSemantic: true,
  });
}

export function computeLineChangeSummary(
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

/**
 * Compute the 0-based line number where the first change occurs.
 * Returns null if the content is identical.
 */
export function firstChangedLine(
  original: string,
  proposed: string,
): number | null {
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

export function computeUserPatch(
  suggestedContent: string,
  appliedContent: string,
): string | undefined {
  if (suggestedContent === appliedContent) {
    return undefined;
  }

  return makePatchText(suggestedContent, appliedContent);
}

// ============================================================================
// Approval queue and request handling
// ============================================================================

export async function requestToolEditApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  const approvalsEnabled = getConfig<boolean>(
    TOOL_EDIT_APPROVAL_CONFIG_KEY,
    true,
  );

  const context = tryUseRunContext();
  const session = getRunContextSession(context) ?? defaultSession();
  const contextStreamId = getRunContextStreamId(context);
  const preparedRequest =
    request.streamId || !contextStreamId
      ? request
      : { ...request, streamId: contextStreamId };

  const streamId = preparedRequest.streamId ?? undefined;
  const isStreamBypassed =
    streamId && session.approvals.toolEdit.bypass.isBypassed(streamId);
  if (!approvalsEnabled || isStreamBypassed) {
    return finalizeApprovalResult({ accepted: true }, preparedRequest);
  }

  return session.approvals.toolEdit.enqueue(streamId ?? undefined, async () => {
    if (streamId && session.approvals.toolEdit.bypass.isBypassed(streamId)) {
      return finalizeApprovalResult({ accepted: true }, preparedRequest);
    }

    const hostInteraction =
      session.interactions.requestToolEditApproval(preparedRequest);
    if (hostInteraction) {
      return finalizeApprovalResult(await hostInteraction, preparedRequest);
    }

    throw new Error(
      'Tool edit approval requires session.interactions.requestToolEditApproval.',
    );
  });
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

  // Compute startLine once here (convert 0-based to 1-based; null → line 1).
  const startLine =
    (firstChangedLine(request.originalContent, appliedContent) ?? 0) + 1;

  return {
    ...result,
    appliedContent,
    userPatch,
    lineChanges:
      result.lineChanges ??
      computeLineChangeSummary(request.originalContent, appliedContent),
    startLine,
  };
}

export function getApprovedContent(
  approval: ToolEditApprovalResult,
  fallback: string,
): string {
  return approval.appliedContent ?? fallback;
}

function formatUnifiedApprovalUserDiff(
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

  // All content is already LF-normalized at the FS read boundary,
  // so comparisons work directly without extra normalization.
  const currentContent = await WorkspaceFS.read(path);

  if (currentContent === finalContent || originalContent === finalContent) {
    return { appliedContent: currentContent, baseContent: currentContent };
  }

  if (currentContent === originalContent) {
    await WorkspaceFS.write(path, finalContent);
    return { appliedContent: finalContent, baseContent: currentContent };
  }

  const { content: patchedContent, results } = applyPatchToText(
    originalContent,
    finalContent,
    currentContent,
  );

  if (results.every(Boolean)) {
    await WorkspaceFS.write(path, patchedContent);
    return { appliedContent: patchedContent, baseContent: currentContent };
  }

  await WorkspaceFS.write(path, finalContent);
  return { appliedContent: finalContent, baseContent: currentContent };
}

/**
 * `writeApprovedContent` plus the `recordToolFileRead` that must always
 * follow it — every edit tool marks the file "read" immediately after a
 * successful approved write so a later edit in the same run doesn't hit the
 * read-before-edit gate. Centralized because every call site paired these two
 * calls by hand and it's an easy one to forget.
 */
async function writeAndRecordApprovedEdit(
  path: string,
  originalContent: string,
  finalContent: string,
): Promise<WriteApprovedContentResult> {
  const result = await writeApprovedContent(
    path,
    originalContent,
    finalContent,
  );
  recordToolFileRead(path);
  return result;
}

/**
 * Append the unified user-adjustment diff note to a base output message, or
 * return the base message unchanged when the user made no adjustments.
 * `separator` defaults to a blank line between the base message and the note.
 */
export function appendApprovalDiffNote(
  baseOutput: string,
  path: string,
  proposedContent: string,
  appliedContent: string,
  separator: string = '\n\n',
): string {
  const diffNote = formatUnifiedApprovalUserDiff(
    path,
    proposedContent,
    appliedContent,
  );
  return diffNote ? `${baseOutput}${separator}${diffNote}` : baseOutput;
}

export function buildApprovalRejectedResult(
  path: string,
  sourceTool: string,
  userMessage?: string,
): ToolResult {
  const baseMessage = `User rejected ${sourceTool} for ${path}.`;
  const feedback = userMessage?.trim();
  const result: ToolResult = {
    status: 'error',
    summary: baseMessage,
    error: baseMessage,
  };
  if (feedback) {
    result.userInstruction = feedback;
  }
  return result;
}

export interface ApprovedEditContent {
  approval: ToolEditApprovalResult;
  /** Content to write: the user's adjustments if any, else the proposal. */
  finalContent: string;
}

/**
 * Run the tool-edit approval handshake for a proposed edit.
 *
 * Returns `{ rejected }` (a {@link ToolResult} to return directly) when the
 * user declines, otherwise the approval plus the resolved `finalContent`.
 * Centralizes the request → reject → resolve sequence shared by every edit
 * tool so `sourceTool` is named once and the rejection message stays uniform.
 * Callers own the write/record/post-processing steps, which vary per tool.
 */
async function requestApprovedEditContent(request: {
  path: string;
  displayPath: string;
  originalContent: string;
  proposedContent: string;
  sourceTool: string;
}): Promise<{ rejected: ToolResult } | ApprovedEditContent> {
  const { path, displayPath, originalContent, proposedContent, sourceTool } =
    request;

  const approval = await requestToolEditApproval({
    path,
    originalContent,
    proposedContent,
    sourceTool,
  });

  if (!approval.accepted) {
    return {
      rejected: buildApprovalRejectedResult(
        displayPath,
        sourceTool,
        approval.userMessage,
      ),
    };
  }

  return {
    approval,
    finalContent: getApprovedContent(approval, proposedContent),
  };
}

interface WrittenApprovedEdit extends WriteApprovedContentResult {
  approval: ToolEditApprovalResult;
}

/**
 * Full approve-then-write handshake for a proposed edit: request approval,
 * then write the resolved content and record the file as read. Combines
 * `requestApprovedEditContent` + `writeAndRecordApprovedEdit`, the exact
 * pairing every straight-through edit call site previously hand-rolled.
 * `beforeWrite` covers work that must happen only after acceptance, such as
 * creating a new file's parent directory.
 */
export async function requestAndWriteApprovedEdit(request: {
  path: string;
  displayPath: string;
  originalContent: string;
  proposedContent: string;
  sourceTool: string;
  beforeWrite?: () => void | Promise<void>;
}): Promise<{ rejected: ToolResult } | WrittenApprovedEdit> {
  const outcome = await requestApprovedEditContent(request);
  if ('rejected' in outcome) {
    return outcome;
  }
  const { approval, finalContent } = outcome;

  await request.beforeWrite?.();

  const written = await writeAndRecordApprovedEdit(
    request.path,
    request.originalContent,
    finalContent,
  );
  return { approval, ...written };
}
