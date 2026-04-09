import {
  diff_match_patch,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
} from 'diff-match-patch';

import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';
import { type LineChanges, type ToolResult } from '@tools/result';
import { getConfig } from '@agent/core/config';
import { WorkspaceFS } from '@utils/files';
import { countLines } from '@utils/text/stringUtils';

import {
  type RejectablePendingEntry,
  rejectPendingEntries,
} from './bashApproval';

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
  /** 1-based line number where the first change occurs (for navigation) */
  startLine?: number;
}

export const TOOL_EDIT_APPROVAL_CONFIG_KEY =
  'texra.toolUse.requireEditApproval';

export const REVEAL_TIMEOUT_MS = 1500;

export const TOOL_EDIT_APPROVAL_ACTIONS = [
  'approve',
  'reject',
  'openDiff',
  'showLatexdiff',
  'previewProposed',
] as const;

export type ToolEditApprovalAction =
  (typeof TOOL_EDIT_APPROVAL_ACTIONS)[number];

let queue: Promise<void> = Promise.resolve();
let customHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;
const bypassedByStream = new Map<StreamTabId, boolean>();

/**
 * Abstract pending approval registry for rejection tracking.
 * The native handler (in @frontend/approval) registers entries here
 * so that stream cleanup can reject them without vscode dependencies.
 */
const pendingApprovals = new Map<string, RejectablePendingEntry>();

/** Register a pending approval entry for rejection tracking. */
export function registerPendingApproval(
  id: string,
  entry: RejectablePendingEntry,
): void {
  pendingApprovals.set(id, entry);
}

/** Unregister a pending approval entry after it has been resolved. */
export function unregisterPendingApproval(id: string): void {
  pendingApprovals.delete(id);
}

function notifyBypassState(streamId: StreamTabId): void {
  bus.emit('updateToolEditApprovalBypassState', {
    streamId,
    bypassActive: bypassedByStream.get(streamId) ?? false,
  });
}

/**
 * Set YOLO bypass state for a stream.
 * @param silent - Skip UI notification. Use when the bypass is set before
 *   the stream is activated (the subsequent SYNC_STREAM_CONTENT will carry
 *   the correct state from isApprovalBypassedForStream).
 */
export function setToolEditApprovalSessionBypass(
  streamId: StreamTabId,
  enabled: boolean,
  options?: { silent?: boolean },
): void {
  bypassedByStream.set(streamId, enabled);
  if (!options?.silent) {
    notifyBypassState(streamId);
  }
}

export function toggleToolEditApprovalSessionBypass(
  streamId: StreamTabId,
): boolean {
  const newState = !(bypassedByStream.get(streamId) ?? false);
  bypassedByStream.set(streamId, newState);
  notifyBypassState(streamId);
  return newState;
}

export function isApprovalBypassedForStream(streamId: StreamTabId): boolean {
  return bypassedByStream.get(streamId) ?? false;
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
  bypassedByStream.delete(streamId);
}

/** @internal Called by unified cleanup in index.ts */
export function _clearAllApprovalBypass(): void {
  bypassedByStream.clear();
}

export function setToolEditApprovalHandler(
  handler?: (
    request: ToolEditApprovalRequest,
  ) => Promise<ToolEditApprovalResult>,
): void {
  customHandler = handler;
}

// ============================================================================
// Pure diff helpers (exported for use by native handler in @frontend/)
// ============================================================================

function createSemanticDiffs(
  original: string,
  proposed: string,
): ReturnType<InstanceType<typeof diff_match_patch>['diff_main']> {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, proposed);
  dmp.diff_cleanupSemantic(diffs);
  return diffs;
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

  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(suggestedContent, appliedContent);

  if (patches.length === 0) {
    return undefined;
  }

  return dmp.patch_toText(patches);
}

// ============================================================================
// Approval queue and request handling
// ============================================================================

async function enqueueApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  // Note: YOLO bypass is checked in requestToolEditApproval before enqueueing
  const run = async () => {
    if (!customHandler) {
      throw new Error(
        'No approval handler registered. Call initializeNativeToolEditApproval first.',
      );
    }
    return customHandler(request);
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

  // Compute startLine once here (convert 0-based to 1-based)
  const changedLine = firstChangedLine(request.originalContent, appliedContent);
  const startLine = changedLine !== null ? changedLine + 1 : 1;

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

  // All content is already LF-normalized at the FS read boundary,
  // so comparisons work directly without extra normalization.
  const currentContent = await WorkspaceFS.read(path);

  if (currentContent === finalContent) {
    return { appliedContent: currentContent, baseContent: currentContent };
  }

  if (originalContent === finalContent) {
    return { appliedContent: currentContent, baseContent: currentContent };
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

export function buildApprovalRejectedResult(
  path: string,
  sourceTool: string,
  userMessage?: string,
): ToolResult {
  const baseMessage = `User rejected ${sourceTool} for ${path}.`;
  const feedback = userMessage?.trim();
  const result: ToolResult = {
    output: baseMessage,
    summary: baseMessage,
    error: baseMessage,
    isError: true,
  };
  if (feedback) {
    result.userInstruction = feedback;
  }
  return result;
}
