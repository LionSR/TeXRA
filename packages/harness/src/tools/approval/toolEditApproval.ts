import { Effect } from 'effect';

import { RunCall, requireRun, sessionOf } from '@agent/runtime/RunCall';
import { ToolContext } from '@agent/core/tools/ToolTypes';
import {
  type RefusalDecision,
  type ToolEditContent,
  type ToolEditPermission,
  type ToolResult,
} from '@shared/schemas';
import { refusalCopy } from '@shared/session/approvalDecision';
import { errorResult } from '@tools/core/result';
import { blobAddress } from '@utils/core/idHash';
import { workspaceRelativePath } from '@utils/files/workspaceFS';
import {
  buildDiffHunks,
  countLineChanges,
  firstChangedLine,
  reportDiffTimeout,
  unifiedDiffText,
  type DiffHunks,
} from '@utils/text/unifiedDiff';

/**
 * What a tool proposes; {@link requestToolEditApproval} derives the rest:
 * the diff a host shows (hunks, the first changed line), computed once, and
 * the permission every surface lists.
 */
export interface ToolEditProposal {
  readonly path: string;
  readonly originalContent: string;
  readonly proposedContent: string;
  readonly sourceTool: string;
}

/**
 * `appliedContent` is required on acceptance: the proposed file as the user
 * left it (the decision's `content`), else the proposal itself, so this is a
 * type-level guarantee rather than a convention callers must null-check.
 */
export type ToolEditApprovalResult =
  | {
      readonly action: 'apply';
      readonly appliedContent: string;
      readonly lineChanges?: {
        readonly added: number;
        readonly removed: number;
      };
      readonly startLine?: number;
    }
  | RefusalDecision;

/** One diff pass over an edit; identical texts skip the engine entirely. */
function diffEdit(original: string, proposed: string): DiffHunks {
  return original === proposed
    ? { hunks: [], timeout: undefined }
    : buildDiffHunks(original, proposed);
}

// ============================================================================
// Approval queue and request handling
// ============================================================================

/**
 * Ask the person for an edit when `sessionPermission` (`loop/toolGuard.ts`),
 * given what the call's hooks said, asks: a `request.opened` on the run
 * that names the proposal's content (the original and proposed text with
 * their diff) by its address in the session's blob store, stored with the
 * row, so every process the request reaches shows the same diff
 * (`request.preview`); serialized behind the run's other prompts, answered
 * by a surface's `request.decide`. An approve applies the file as the
 * person left it: the decision's content, else the proposal.
 */
export const requestToolEditApproval = Effect.fn('requestToolEditApproval')(
  function* (
    request: ToolEditProposal,
  ): Effect.fn.Return<ToolEditApprovalResult, Error, ToolContext> {
    const call = yield* requireRun('A tool-edit approval');
    const { run, requests } = call;
    const session = sessionOf(run);
    const { runId } = run;
    const acceptProposedAsIs = (): Effect.Effect<ToolEditApprovalResult> =>
      finalizeApprovalResult(request.proposedContent, request);
    const hook = (yield* RunCall)?.hook;
    const answer = session.approvals.permission(runId, 'toolEdit', hook);
    if (answer === 'allow') return yield* acceptProposedAsIs();
    if (answer !== 'ask') return answer;

    // One diff pass gives the hunks, their line counts and the first
    // changed line, so every surface reports the same numbers for one edit.
    const { originalContent, proposedContent, path, sourceTool } = request;
    const { hunks, timeout } = diffEdit(originalContent, proposedContent);
    yield* reportDiffTimeout(timeout);
    const lines = countLineChanges(hunks);
    const content: ToolEditContent = {
      originalContent,
      proposedContent,
      hunks,
      firstChangedLine: firstChangedLine(hunks, proposedContent),
    };
    const text = JSON.stringify(content);
    const address = blobAddress(text);
    const permission: ToolEditPermission = {
      requestId: requests.nextId('toolEdit'),
      path,
      // The call's own workspace root, as data: the display path a host
      // shows is relative to the session that raised the request, not to
      // whichever roots the answering fiber happens to carry.
      relativePath: workspaceRelativePath(call.env.roots.workspace, path),
      sourceTool,
      allowBypass:
        hook !== 'ask' && session.approvals.bypass(runId, 'toolEdit') === null,
      runId,
      addedLines: lines.added,
      removedLines: lines.removed,
      content: address,
    };
    const review = requests
      .open({ kind: 'toolEdit', data: permission }, [{ digest: address, text }])
      .pipe(
        Effect.flatMap((decided): Effect.Effect<ToolEditApprovalResult> =>
          decided.action !== 'approve'
            ? Effect.succeed(decided)
            : // The decision carries the proposed file as the person left
              // it in a host's view; one naming no content applies the
              // proposal. A host read the bytes itself, so they may be CRLF.
              finalizeApprovalResult(
                (decided.content ?? request.proposedContent).replaceAll(
                  '\r\n',
                  '\n',
                ),
                request,
              ),
        ),
      );
    // An edit grant turned on while it waited answers it, unless a hook
    // asked.
    return yield* session.approvals.enqueue('toolEdit', runId, {
      prompt: review,
      bypassed: hook === 'ask' ? review : Effect.suspend(acceptProposedAsIs),
    });
  },
);

function finalizeApprovalResult(
  appliedContent: string,
  request: ToolEditProposal,
): Effect.Effect<ToolEditApprovalResult> {
  // One pass answers both the start line and the counts.
  const { hunks, timeout } = diffEdit(request.originalContent, appliedContent);

  // Compute startLine once here (convert 0-based to 1-based; null → line 1).
  const startLine = (firstChangedLine(hunks, appliedContent) ?? 0) + 1;

  return reportDiffTimeout(timeout).pipe(
    Effect.as({
      action: 'apply' as const,
      appliedContent,
      lineChanges: countLineChanges(hunks),
      startLine,
    }),
  );
}

/**
 * Append the unified user-adjustment diff note to a base output message, or
 * return the base message unchanged when the user made no adjustments.
 */
export function appendApprovalDiffNote(
  baseOutput: string,
  path: string,
  proposedContent: string,
  appliedContent: string,
): Effect.Effect<string> {
  const diff = unifiedDiffText(proposedContent, appliedContent);
  return reportDiffTimeout(diff.timeout).pipe(
    Effect.as(
      diff.text
        ? `${baseOutput}\n\nUser adjustments to ${path}:\n\n\`\`\`diff\n${diff.text}\n\`\`\``
        : baseOutput,
    ),
  );
}

export function buildApprovalRejectedResult(
  path: string,
  sourceTool: string,
  refusal: RefusalDecision,
): ToolResult {
  const copy = refusalCopy('Tool edit', refusal);
  const summary =
    refusal.action === 'reject'
      ? `User rejected ${sourceTool} for ${path}.`
      : `${copy.summary}: ${sourceTool} for ${path}.`;
  // `refusalCopy` already trims a detail and drops an empty one.
  const error = copy.detail ? `${summary}\n\n${copy.detail}` : summary;
  return errorResult(error, {
    summary,
    ...(copy.feedback && { userInstruction: copy.feedback }),
  });
}
