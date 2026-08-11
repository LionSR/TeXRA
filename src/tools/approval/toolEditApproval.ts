import {
  currentSession,
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  getRunContextSession,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import { isLatexFile } from '@common/files/fileTypeUtils';
import {
  decideTexraApproval,
  isTexraApprovalDenied,
  texraApprovalDenialMessage,
} from '@shared/approvalPolicy';
import type { StreamTabId, ToolEditPermission } from '@shared/schemas';
import type { LineChanges } from '@shared/schemas/lineChanges';
import { type ToolResult } from '@shared/schemas/toolResult';
import { recordToolFileRead } from '@tools/fileInteractions';
import { errorResult } from '@tools/core/result';
import { WorkspaceFS } from '@utils/files/workspaceFS';
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

/**
 * Tool-edit approval request / result shapes.
 *
 * Hosts receive these through `SessionHandle.interactions`, not through the
 * process-wide Platform object — this is a session-scoped host-interaction
 * contract, not a `Platform` port.
 */
export interface ToolEditApprovalRequest {
  readonly path: string;
  readonly originalContent: string;
  readonly proposedContent: string;
  readonly sourceTool: string;
  readonly streamId?: string | null;
}

/**
 * `appliedContent` is required on acceptance — every host implementation
 * always supplies the content the user actually approved, so this is a
 * type-level guarantee rather than a convention callers must null-check.
 */
export type ToolEditApprovalResult =
  | {
      readonly accepted: true;
      readonly appliedContent: string;
      readonly userPatch?: string;
      readonly lineChanges?: {
        readonly added: number;
        readonly removed: number;
      };
      readonly startLine?: number;
    }
  | {
      readonly accepted: false;
      readonly userMessage?: string;
    };

const TOOL_EDIT_APPROVAL_CONFIG_KEY = 'texra.toolUse.requireEditApproval';

export const REVEAL_TIMEOUT_MS = 1500;

export function setToolEditApprovalSessionBypass(
  streamId: StreamTabId,
  enabled: boolean,
  options?: { silent?: boolean; session?: SessionHandle },
): void {
  (options?.session ?? currentSession()).approvals.toolEdit.bypass.setBypass(
    streamId,
    enabled,
    options,
  );
}

export function isApprovalBypassedForStream(
  streamId: StreamTabId,
  session: SessionHandle = currentSession(),
): boolean {
  return session.approvals.toolEdit.bypass.isBypassed(streamId);
}

/**
 * Prepare a tool-edit approval prompt for the host: register the
 * stream awaiting input (without switching the active tab — the request
 * surfaces as a pending badge on the stream's row, #8246) and construct the
 * permission payload with the bypass affordance gated on the stream's current
 * bypass state.
 *
 * Shared host-agnostic logic behind `ToolEditApprovalController`. Each host
 * computes `relativePath` in its own way; opening the view is owned here so a
 * prompt cannot be published to a hidden view on one host and a visible one on
 * another.
 */
export function prepareToolEditApprovalPrompt(
  interactions: Pick<SessionHostInteractions, 'emit'>,
  session: SessionHandle,
  params: {
    requestId: string;
    request: ToolEditApprovalRequest;
    relativePath: string;
  },
): ToolEditPermission {
  const { requestId, request, relativePath } = params;
  const { streamId } = request;
  if (streamId) {
    interactions.emit('requestEnsureProgressView', {});
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
  const lineChanges = computeLineChangeSummary(
    request.originalContent,
    request.proposedContent,
  );
  return {
    requestId,
    path: request.path,
    relativePath,
    sourceTool: request.sourceTool,
    allowBypass: !isBypassed,
    streamId: streamId ?? '',
    addedLines: lineChanges.added,
    removedLines: lineChanges.removed,
    isLatex: isLatexFile(request.path),
  };
}

// ============================================================================
// Pure diff helpers, shared with the hosts' native approval/diff surfaces
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
  const isStreamBypassed = Boolean(
    streamId && session.approvals.toolEdit.bypass.isBypassed(streamId),
  );
  const acceptProposedAsIs = (): ToolEditApprovalResult =>
    finalizeApprovalResult(
      { accepted: true, appliedContent: preparedRequest.proposedContent },
      preparedRequest,
    );
  const decision = decideTexraApproval({
    policy: session.approvalPolicy,
    promptRequired: approvalsEnabled,
    scopedBypass: isStreamBypassed,
    canPresent: context?.approvalPromptsUnavailable !== true,
  });
  if (decision === 'allow') return acceptProposedAsIs();
  if (isTexraApprovalDenied(decision)) {
    context?.onApprovalPolicyDenial?.();
    return {
      accepted: false,
      userMessage: texraApprovalDenialMessage(decision),
    };
  }

  return session.approvals.toolEdit.enqueue(streamId, {
    prompt: async () => {
      const hostInteraction =
        session.interactions.requestToolEditApproval(preparedRequest);
      if (!hostInteraction) {
        throw new Error(
          'Tool edit approval requires session.interactions.requestToolEditApproval.',
        );
      }
      return finalizeApprovalResult(await hostInteraction, preparedRequest);
    },
    bypassed: acceptProposedAsIs,
  });
}

function finalizeApprovalResult(
  result: ToolEditApprovalResult,
  request: ToolEditApprovalRequest,
): ToolEditApprovalResult {
  if (!result.accepted) {
    return result;
  }

  const { appliedContent } = result;
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

/** The `accepted: true` branch of {@link ToolEditApprovalResult}. */
export type AcceptedToolEditApprovalResult = Extract<
  ToolEditApprovalResult,
  { accepted: true }
>;

interface WriteApprovedContentResult {
  appliedContent: string;
  baseContent: string;
}

/**
 * Reconcile approved content with the current workspace file and mark the path
 * as read after the operation succeeds, so every approved-write caller keeps
 * the later-edit guard in sync.
 */
export async function writeApprovedContent(
  path: string,
  originalContent: string,
  finalContent: string,
): Promise<WriteApprovedContentResult> {
  const exists = await WorkspaceFS.exists(path);
  let baseContent = '';
  let appliedContent = finalContent;
  let shouldWrite = true;

  if (exists) {
    // All content is already LF-normalized at the FS read boundary,
    // so comparisons work directly without extra normalization.
    const currentContent = await WorkspaceFS.read(path);
    baseContent = currentContent;

    if (currentContent === finalContent || originalContent === finalContent) {
      appliedContent = currentContent;
      shouldWrite = false;
    } else if (currentContent !== originalContent) {
      const { content: patchedContent, results } = applyPatchToText(
        originalContent,
        finalContent,
        currentContent,
      );
      appliedContent = results.every(Boolean) ? patchedContent : finalContent;
    }
  }

  if (shouldWrite) {
    await WorkspaceFS.write(path, appliedContent);
  }
  recordToolFileRead(path);
  return { appliedContent, baseContent };
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
  const diffBody = computeUserPatch(proposedContent, appliedContent);
  return diffBody
    ? `${baseOutput}${separator}User adjustments to ${path}:\n\n\`\`\`diff\n${diffBody}\n\`\`\``
    : baseOutput;
}

export function buildApprovalRejectedResult(
  path: string,
  sourceTool: string,
  userMessage?: string,
): ToolResult {
  const baseMessage = `User rejected ${sourceTool} for ${path}.`;
  const feedback = userMessage?.trim();
  return errorResult(baseMessage, {
    summary: baseMessage,
    ...(feedback && { userInstruction: feedback }),
  });
}

interface WrittenApprovedEdit extends WriteApprovedContentResult {
  approval: AcceptedToolEditApprovalResult;
}

/**
 * Full approve-then-write handshake for a proposed edit: request approval,
 * then write the resolved content (the user's adjustments if any, else the
 * proposal). `sourceTool` is named once and the rejection message is uniform
 * across every straight-through edit call site.
 *
 * Returns `{ rejected }` (a {@link ToolResult} to return directly) when the
 * user declines. `beforeWrite` covers work that must happen only after
 * acceptance, such as creating a new file's parent directory.
 */
export async function requestAndWriteApprovedEdit(request: {
  path: string;
  displayPath: string;
  originalContent: string;
  proposedContent: string;
  sourceTool: string;
  beforeWrite?: () => void | Promise<void>;
}): Promise<{ rejected: ToolResult } | WrittenApprovedEdit> {
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

  await request.beforeWrite?.();

  const written = await writeApprovedContent(
    path,
    originalContent,
    approval.appliedContent,
  );
  return { approval, ...written };
}
