import {
  diff_match_patch,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
} from 'diff-match-patch';
import { z } from 'zod';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { getCurrentToolRunContext } from '@agent/toolUse/ToolFileInteractionContext';
import { getConfig } from '@agent/core/config';
import { StreamTabIdSchema, type StreamTabId } from '@shared/schemas';
import {
  LineChangesSchema,
  type LineChanges,
  type ToolResult,
} from '@tools/result';
import { WorkspaceFS } from '@utils/files';
import { countLines } from '@utils/text/stringUtils';

import { createStreamApprovalController } from './streamApprovalQueue';

export const ToolEditApprovalRequestSchema = z.object({
  path: z.string(),
  originalContent: z.string(),
  proposedContent: z.string(),
  sourceTool: z.string(),
  streamId: StreamTabIdSchema.optional(),
});
export type ToolEditApprovalRequest = z.infer<
  typeof ToolEditApprovalRequestSchema
>;

export const ToolEditApprovalResultSchema = z.object({
  accepted: z.boolean(),
  userMessage: z.string().optional(),
  appliedContent: z.string().optional(),
  userPatch: z.string().optional(),
  lineChanges: LineChangesSchema.optional(),
  /** 1-based line number where the first change occurs (for navigation) */
  startLine: z.number().optional(),
});
export type ToolEditApprovalResult = z.infer<
  typeof ToolEditApprovalResultSchema
>;

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

export const toolEditApprovalController =
  createStreamApprovalController<ToolEditApprovalResult>({
    rejectionResult: () => ({ accepted: false }),
  });

let customHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;

/** Register a pending approval entry for rejection tracking. */
export function registerPendingApproval(
  id: string,
  entry: {
    streamId?: StreamTabId;
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
  toolEditApprovalController.setBypass(streamId, enabled);
  if (!options?.silent) {
    runtimeHost.emit('updateToolEditApprovalBypassState', {
      streamId,
      bypassActive: enabled,
    });
  }
}

export function toggleToolEditApprovalSessionBypass(
  streamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
): boolean {
  const next = !toolEditApprovalController.isBypassed(streamId);
  setToolEditApprovalSessionBypass(streamId, next, runtimeHost);
  return next;
}

export function isApprovalBypassedForStream(streamId: StreamTabId): boolean {
  return toolEditApprovalController.isBypassed(streamId);
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

  const context = getCurrentToolRunContext();
  const preparedRequest =
    request.streamId || !context?.streamId
      ? request
      : { ...request, streamId: context.streamId };

  const streamId = preparedRequest.streamId;
  const isStreamBypassed =
    streamId && toolEditApprovalController.isBypassed(streamId);
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

/**
 * Enable tool-edit YOLO on a freshly resolved child subagent stream.
 *
 * Used by DelegationTools when launching a subagent that should inherit the
 * parent's auto-approval. Silent because it fires before the child stream is
 * activated; the subsequent SYNC_STREAM_CONTENT carries the bypass state.
 */
export function enableYoloOnChildStream(childStreamId: StreamTabId): void {
  toolEditApprovalController.setBypass(childStreamId, true);
}
