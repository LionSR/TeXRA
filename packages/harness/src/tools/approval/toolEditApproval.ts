import { Effect } from 'effect';

import { inRunSession, type RunToolCall } from '@agent/runtime/RunCall';
import { ToolContext } from '@tools/core/ToolTypes';
import {
  readToolEditContent,
  type RefusalDecision,
  type ToolEditRequest,
  type ToolResult,
} from '@shared/schemas';
import { refusalCopy } from '@tools/approval/refusalCopy';
import { Approvals, SessionLog } from '@shared/session/runHistory';
import { errorResult } from '@tools/core/result';
import {
  buildDiffHunks,
  countLineChanges,
  firstChangedLine,
  reportDiffTimeout,
  unifiedDiffText,
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

const reviewEdit = Effect.fnUntraced(function* (
  originalContent: string | null,
  proposedContent: string,
): Effect.fn.Return<Effect.Success<ReturnType<typeof readToolEditContent>>> {
  const original = originalContent ?? '';
  const { hunks, timeout } =
    original === proposedContent
      ? { hunks: [], timeout: undefined }
      : buildDiffHunks(original, proposedContent);
  yield* reportDiffTimeout(timeout);
  return {
    originalContent,
    proposedContent,
    hunks,
    firstChangedLine: firstChangedLine(hunks, proposedContent),
  };
});

// ============================================================================
// Approval queue and request handling
// ============================================================================

/**
 * Ask the person for an edit when the session's policy, given what the
 * call's hooks said, asks: a `request.opened` on the run
 * that names the proposal's content (the original and proposed text with
 * their diff) by its address in the session's blob store, stored with the
 * row, so every process the request reaches shows the same diff
 * (`request.preview`); answered by a surface's `request.decide`, or by the
 * edit grant turned on meanwhile. An approve applies the file as the
 * person left it: the approval's tool edit, else the proposal.
 */
export const requestToolEditApproval = (
  request: ToolEditProposal,
): Effect.Effect<ToolEditApprovalResult, Error, ToolContext> =>
  inRunSession(
    Effect.fn('requestToolEditApproval')(function* (call: RunToolCall) {
      const { run, requests, hook } = call;
      const { runId } = run;
      const approvals = yield* Approvals;
      const answer = approvals.permission(runId, 'toolEdit', hook);
      if (answer !== 'ask' && answer !== 'allow') return answer;

      const { originalContent, proposedContent, path, sourceTool } = request;
      let reviewed = yield* reviewEdit(originalContent, proposedContent);
      let lineChanges = countLineChanges(reviewed.hunks);
      let appliedContent = proposedContent;
      if (answer === 'ask') {
        const text = JSON.stringify(reviewed);
        const address = blobAddress(text);
        const permission: ToolEditRequest = {
          requestId: requests.nextId(),
          path,
          relativePath: workspaceRelativePath(call.env.roots.workspace, path),
          sourceTool,
          runId,
          addedLines: lineChanges.added,
          removedLines: lineChanges.removed,
          content: address,
        };
        const { payload, decision } = yield* requests.open(
          { kind: 'toolEdit', data: permission },
          { blobs: [{ digest: address, text }] },
        );
        if (decision.action !== 'approve') return decision;
        const log = yield* SessionLog;
        // After a resume the stored proposal is still the one under review.
        reviewed = yield* readToolEditContent(log.blobs, payload.data.content);
        lineChanges = {
          added: payload.data.addedLines,
          removed: payload.data.removedLines,
        };
        appliedContent = (
          decision.edit?.content ?? reviewed.proposedContent
        ).replaceAll('\r\n', '\n');
      }

      let firstLine = reviewed.firstChangedLine;
      if (appliedContent !== reviewed.proposedContent) {
        const applied = yield* reviewEdit(
          reviewed.originalContent,
          appliedContent,
        );
        lineChanges = countLineChanges(applied.hunks);
        firstLine = applied.firstChangedLine;
      }
      return {
        action: 'apply' as const,
        originalContent: reviewed.originalContent,
        proposedContent: reviewed.proposedContent,
        appliedContent,
        lineChanges,
        startLine: (firstLine ?? 0) + 1,
      };
    }),
  );

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
