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
import type { RejectionProvenance } from '@agent/runtime/HostInteractions';
import { isLatexFile } from '@common/files/fileTypeUtils';
import {
  decideTexraApproval,
  isTexraApprovalDenied,
  texraApprovalDenialMessage,
} from '@shared/approvalPolicy';
import type {
  LineChanges,
  StreamTabId,
  ToolEditPermission,
  ToolResult,
} from '@shared/schemas';
import { recordToolFileRead } from '@tools/fileInteractions';
import { errorResult } from '@tools/core/result';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { getConfig } from '@utils/config/configUtils';
import { applyPatchToText } from '@utils/text/diff';
import { buildDiffHunks, unifiedDiffText } from '@utils/text/unifiedDiff';
import { isNonEmptyString } from '@utils/text/stringUtils';

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
  readonly streamId?: StreamTabId | null;
}

/**
 * `appliedContent` is required on acceptance — every host implementation
 * always supplies the content the user actually approved, so this is a
 * type-level guarantee rather than a convention callers must null-check.
 */
export type ToolEditApprovalResult =
  | {
      readonly action: 'apply';
      readonly appliedContent: string;
      readonly userPatch?: string;
      readonly lineChanges?: {
        readonly added: number;
        readonly removed: number;
      };
      readonly startLine?: number;
    }
  | ({ readonly action: 'reject' } & RejectionProvenance);

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
 * Build the tool-edit permission payload every host publishes to its approval
 * surface, the tool-edit counterpart of `prepareBashApprovalPrompt`.
 *
 * Owning it here gives one bypass-affordance derivation and one line-change
 * computation, so the TUI's inline card and the webview panel cannot report
 * different numbers for the same edit. The host supplies the `requestId` it
 * tracks the request under and the display path it shows; revealing the host's
 * approval surface belongs to the caller, not to this projection — a host with
 * no separate view has nothing to reveal.
 */
export function prepareToolEditApprovalPrompt(
  session: SessionHandle,
  params: {
    requestId: string;
    request: ToolEditApprovalRequest;
    relativePath: string;
  },
): ToolEditPermission {
  const { requestId, request, relativePath } = params;
  const { streamId } = request;
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

/**
 * Added/removed line counts for an edit, folded from the very hunks the host
 * renders underneath them — the CLI card's `+N / −M` header and the diff body
 * below it are now two readings of one computation, not two engines.
 */
export function computeLineChangeSummary(
  original: string,
  proposed: string,
): LineChanges {
  if (original === proposed) {
    return { added: 0, removed: 0 };
  }

  let added = 0;
  let removed = 0;
  for (const hunk of buildDiffHunks(original, proposed)) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

/**
 * The 0-based line number in the proposed text where the first change occurs,
 * used to scroll a host's diff view to it. Returns null if the content is
 * identical.
 */
export function firstChangedLine(
  original: string,
  proposed: string,
): number | null {
  if (original === proposed) {
    return null;
  }

  const [hunk] = buildDiffHunks(original, proposed);
  if (!hunk) return null;

  let line = hunk.newStart;
  for (const text of hunk.lines) {
    const marker = text.at(0);
    if (marker === '+') return line - 1;
    // A deletion has no line of its own in the proposed text; reveal the
    // position it was removed from.
    if (marker === '-') return Math.max(line - 1, 0);
    line += 1;
  }
  return Math.max(hunk.newStart - 1, 0);
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
      { action: 'apply', appliedContent: preparedRequest.proposedContent },
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
      action: 'reject',
      reason: texraApprovalDenialMessage(decision),
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
  if (result.action !== 'apply') {
    return result;
  }

  const { appliedContent } = result;
  const userPatch =
    result.userPatch ??
    unifiedDiffText(request.proposedContent, appliedContent);

  // Compute startLine once here (convert 0-based to 1-based; null → line 1).
  const startLine =
    (firstChangedLine(request.originalContent, appliedContent) ?? 0) + 1;

  return {
    ...result,
    userPatch,
    lineChanges:
      result.lineChanges ??
      computeLineChangeSummary(request.originalContent, appliedContent),
    startLine,
  };
}

/** The `action: 'apply'` branch of {@link ToolEditApprovalResult}. */
export type AcceptedToolEditApprovalResult = Extract<
  ToolEditApprovalResult,
  { action: 'apply' }
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
  const diffBody = unifiedDiffText(proposedContent, appliedContent);
  return diffBody
    ? `${baseOutput}${separator}User adjustments to ${path}:\n\n\`\`\`diff\n${diffBody}\n\`\`\``
    : baseOutput;
}

/**
 * Reader-side provenance: deliberately NOT `RejectionProvenance`. A caller
 * summarizing several rejected edits at once (`accept_run_files`) can hold a
 * user rejection, a policy denial, and a cancellation simultaneously, so this
 * shape is the loose aggregate the message builder reads, not the exclusive
 * union a single settlement produces.
 */
interface ToolEditRejectionProvenance {
  readonly feedback?: string;
  readonly reason?: string;
  readonly cause?: string;
}

export function buildApprovalRejectedResult(
  path: string,
  sourceTool: string,
  rejection: ToolEditRejectionProvenance,
): ToolResult {
  const feedback = rejection.feedback?.trim();
  const isPolicyDenial = rejection.reason !== undefined;
  const isAutomaticCancellation = 'cause' in rejection;
  const reason = rejection.reason?.trim();
  const cause = rejection.cause?.trim();
  let summary = `User rejected ${sourceTool} for ${path}.`;
  if (isPolicyDenial) {
    summary = `Tool edit denied: ${sourceTool} for ${path}.`;
  }
  // Cancellation outranks policy denial in the summary.
  if (isAutomaticCancellation) {
    summary = `Tool edit approval cancelled: ${sourceTool} for ${path}.`;
  }
  const details = [reason, cause].filter(isNonEmptyString);
  const error =
    details.length > 0 ? `${summary}\n\n${details.join('\n')}` : summary;
  return errorResult(error, {
    summary,
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

  if (approval.action !== 'apply') {
    return {
      rejected: buildApprovalRejectedResult(displayPath, sourceTool, approval),
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
