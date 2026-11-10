import { Effect } from 'effect';

import { inRunSession, type RunToolCall } from '@agent/runtime/RunCall';
import { ToolContext } from '@agent/core/tools/ToolTypes';
import {
  readToolEditContent,
  type RefusalDecision,
  type ToolEditRequest,
  type ToolResult,
} from '@shared/schemas';
import { refusalCopy } from '@shared/session/approvalDecision';
import { Approvals, SessionLog } from '@shared/session/runHistory';
import { errorResult } from '@tools/core/result';
import {
  buildDiffHunks,
  countLineChanges,
  firstChangedLine,
  reportDiffTimeout,
  unifiedDiffText,
  type DiffHunks,
} from '@tools/unifiedDiff';
import { blobAddress } from '@utils/core/idHash';
import { workspaceRelativePath } from '@utils/files/workspaceFS';

/**
 * What a tool proposes; {@link requestToolEditApproval} derives the rest:
 * the diff a host shows (hunks, the first changed line), computed once, and
 * the permission every surface lists.
 */
export interface ToolEditProposal {
  readonly path: string;
  /** Null when the file did not exist when this edit was proposed. */
  readonly originalContent: string | null;
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
      /** The reviewed base, used to reconcile changes made while waiting. */
      readonly originalContent: string | null;
      /** The reviewed proposal, before any edits made in the approval view. */
      readonly proposedContent: string;
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
 * (`request.preview`); answered by a surface's `request.decide`, or by the
 * edit grant turned on meanwhile. An approve applies the file as the
 * person left it: the decision's content, else the proposal.
 */
export const requestToolEditApproval = (
  request: ToolEditProposal,
): Effect.Effect<ToolEditApprovalResult, Error, ToolContext> =>
  inRunSession(
    Effect.fn('requestToolEditApproval')(function* (call: RunToolCall) {
      const { run, requests, hook } = call;
      const { runId } = run;
      const approvals = yield* Approvals;
      const log = yield* SessionLog;
      const acceptProposedAsIs = (): Effect.Effect<ToolEditApprovalResult> =>
        finalizeApprovalResult(request.proposedContent, request);
      const answer = approvals.permission(runId, 'toolEdit', hook);
      if (answer === 'allow') return yield* acceptProposedAsIs();
      if (answer !== 'ask') return answer;

      // One diff pass gives the hunks, their line counts and the first
      // changed line, so every surface reports the same numbers for one edit.
      const { originalContent, proposedContent, path, sourceTool } = request;
      const { hunks, timeout } = diffEdit(
        originalContent ?? '',
        proposedContent,
      );
      yield* reportDiffTimeout(timeout);
      const lines = countLineChanges(hunks);
      const content: Effect.Success<ReturnType<typeof readToolEditContent>> = {
        originalContent,
        proposedContent,
        hunks,
        firstChangedLine: firstChangedLine(hunks, proposedContent),
      };
      const text = JSON.stringify(content);
      const address = blobAddress(text);
      const permission: ToolEditRequest = {
        requestId: requests.nextId('toolEdit'),
        path,
        // The call's own workspace root, as data: the display path a host
        // shows is relative to the session that raised the request, not to
        // whichever roots the answering fiber happens to carry.
        relativePath: workspaceRelativePath(call.env.roots.workspace, path),
        sourceTool,
        runId,
        addedLines: lines.added,
        removedLines: lines.removed,
        content: address,
      };
      return yield* requests
        .open(
          { kind: 'toolEdit', data: permission },
          { blobs: [{ digest: address, text }] },
        )
        .pipe(
          Effect.flatMap(
            ({ payload, decision }): Effect.Effect<ToolEditApprovalResult> =>
              decision.action !== 'approve'
                ? Effect.succeed(decision)
                : readToolEditContent(log.blobs, payload.data.content).pipe(
                    Effect.flatMap((reviewed) =>
                      // A host's edited bytes may be CRLF. The base and proposal
                      // are the request's stored ones, including after a resume.
                      finalizeApprovalResult(
                        (
                          decision.content ?? reviewed.proposedContent
                        ).replaceAll('\r\n', '\n'),
                        reviewed,
                      ),
                    ),
                  ),
          ),
        );
    }),
  );

function finalizeApprovalResult(
  appliedContent: string,
  request: Pick<ToolEditProposal, 'originalContent' | 'proposedContent'>,
): Effect.Effect<ToolEditApprovalResult> {
  // One pass answers both the start line and the counts.
  const { hunks, timeout } = diffEdit(
    request.originalContent ?? '',
    appliedContent,
  );

  // Compute startLine once here (convert 0-based to 1-based; null → line 1).
  const startLine = (firstChangedLine(hunks, appliedContent) ?? 0) + 1;

  return reportDiffTimeout(timeout).pipe(
    Effect.as({
      action: 'apply' as const,
      appliedContent,
      originalContent: request.originalContent,
      proposedContent: request.proposedContent,
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
