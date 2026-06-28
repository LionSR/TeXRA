import { z } from 'zod';
import { diff_match_patch } from 'diff-match-patch';

import { tryUseRunContext } from '@agent/runtime/RunContext';
import { isLatexFile } from '@common/files/fileTypeUtils';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import { StreamTabIdSchema, type StreamTabId } from '@shared/schemas';
import type { ToolEditApprovalAction } from '@shared/schemas/prompts';
import {
  computeLineChangeSummary,
  computeUserPatch,
  firstChangedLine,
} from '@shared/approval/toolEditDiff';
import {
  LineChangesSchema,
  type LineChanges,
} from '@shared/schemas/lineChanges';
import { type ToolResult } from '@shared/schemas/toolResult';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config/configUtils';

import { bashApprovalController } from './bashApproval';
import { createStreamApprovalController } from './streamApprovalQueue';

const ToolEditApprovalRequestSchema = z.object({
  path: z.string(),
  originalContent: z.string(),
  proposedContent: z.string(),
  sourceTool: z.string(),
  streamId: StreamTabIdSchema.nullish(),
});
export type ToolEditApprovalRequest = z.infer<
  typeof ToolEditApprovalRequestSchema
>;

const ToolEditApprovalResultSchema = z.object({
  accepted: z.boolean(),
  userMessage: z.string().optional(),
  appliedContent: z.string().optional(),
  userPatch: z.string().optional(),
  lineChanges: LineChangesSchema.optional(),
  /** 1-based line number where the first change occurs (for navigation) */
  startLine: z.int().positive().optional(),
});
export type ToolEditApprovalResult = z.infer<
  typeof ToolEditApprovalResultSchema
>;

const TOOL_EDIT_APPROVAL_CONFIG_KEY = 'texra.toolUse.requireEditApproval';

export const toolEditApprovalController =
  createStreamApprovalController<ToolEditApprovalResult>({
    rejectionResult: () => ({ accepted: false }),
    bypassEvent: 'updateToolEditApprovalBypassState',
  });

let customHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;

/** Register a pending approval entry for rejection tracking. */
export function registerPendingApproval(
  id: string,
  entry: {
    streamId?: StreamTabId;
    runtimeHost?: AgentRuntimeHost;
    isSettled: () => boolean;
    settle: (result: ToolEditApprovalResult) => void;
  },
): void {
  toolEditApprovalController.registerPending(id, entry);
}

/** Unregister a pending approval entry after it has been resolved. */
export function unregisterPendingApproval(id: string): void {
  toolEditApprovalController.unregisterPending(id);
}

export function setToolEditApprovalSessionBypass(
  streamId: StreamTabId,
  enabled: boolean,
  runtimeHost: AgentRuntimeHost,
  options?: { silent?: boolean },
): void {
  toolEditApprovalController.bypass.setBypass(
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
): boolean {
  return toolEditApprovalController.bypass.toggleBypass(streamId, runtimeHost);
}

export function isApprovalBypassedForStream(streamId: StreamTabId): boolean {
  return toolEditApprovalController.bypass.isBypassed(streamId);
}

/**
 * Emit the tool-edit approval prompt to the progress view: activate the stream
 * awaiting input and post the `showToolEditPermission` event with the bypass
 * affordance gated on the stream's current bypass state.
 *
 * Shared host-agnostic logic for the VS Code (`nativeToolEditApproval`) and
 * desktop (`desktopToolEditApproval`) approval surfaces. Each host computes
 * `relativePath` in its own way and performs any host-specific routing (e.g.
 * revealing the progress view) around this call.
 */
export function emitToolEditApprovalPrompt(
  runtimeHost: AgentRuntimeHost,
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
    runtimeHost.emit('setActiveStream', { streamId });
  }
  const isBypassed = streamId ? isApprovalBypassedForStream(streamId) : false;
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

export function setToolEditApprovalHandler(
  handler?: (
    request: ToolEditApprovalRequest,
  ) => Promise<ToolEditApprovalResult>,
): void {
  customHandler = handler;
}

// ============================================================================
// Approval queue and request handling
// ============================================================================

async function enqueueApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  return toolEditApprovalController.enqueue(async () => {
    if (!customHandler) {
      throw new Error(
        'No approval handler registered. Call initializeNativeToolEditApproval first.',
      );
    }
    return customHandler(request);
  });
}

export async function requestToolEditApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  const approvalsEnabled = getConfig<boolean>(
    TOOL_EDIT_APPROVAL_CONFIG_KEY,
    true,
  );

  const context = tryUseRunContext();
  const preparedRequest =
    request.streamId || !context?.streamId
      ? request
      : { ...request, streamId: context.streamId };

  const streamId = preparedRequest.streamId;
  const isStreamBypassed =
    streamId && toolEditApprovalController.bypass.isBypassed(streamId);
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
export async function requestApprovedEditContent(request: {
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

/**
 * Mirror the parent stream's bash-approval bypass onto a freshly resolved child
 * subagent stream, independent of any tool-edit auto-approval.
 *
 * A child delegated by a parent that auto-runs bash should auto-run bash too. If
 * the parent's bash is still gated this is a no-op — fresh child streams default
 * to gated — so the child matches the parent either way. Kept separate from the
 * tool-edit YOLO flag to respect the CLI's distinct AUTO-BASH / AUTO-APPROVE
 * grants: a parent with AUTO-BASH but edits still gated still propagates bash.
 */
export function inheritBashBypassOnChildStream(
  childStreamId: StreamTabId,
  parentStreamId?: StreamTabId,
): void {
  if (
    parentStreamId &&
    bashApprovalController.bypass.isBypassed(parentStreamId)
  ) {
    bashApprovalController.bypass.setBypass(childStreamId, true);
  }
}

/**
 * Enable tool-edit auto-approval on a freshly resolved child subagent stream.
 *
 * Used by DelegationTools when the parent is auto-approving edits / delegated
 * tasks. Silent because it fires before the child stream is activated; the
 * subsequent SYNC_STREAM_CONTENT carries the tool-edit / super-YOLO bypass.
 * Bash bypass is handled separately by `inheritBashBypassOnChildStream` so it
 * follows the parent regardless of the tool-edit flag.
 */
export function enableYoloOnChildStream(childStreamId: StreamTabId): void {
  toolEditApprovalController.bypass.setBypass(childStreamId, true);
}
