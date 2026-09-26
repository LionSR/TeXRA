import { Cause, Effect } from 'effect';

import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { ToolCall } from '@agent/runtime/ToolCall';
import { isLatexFile } from '@common/files/fileTypeUtils';
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  decideTexraApproval,
  isTexraApprovalDenied,
  texraApprovalDenialMessage,
} from '@shared/approvalPolicy';
import {
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
  type LineChanges,
  type RequestRefusal,
  type RunId,
  type ToolEditPermission,
  type ToolResult,
} from '@shared/schemas';
import { refusalCopy, refusalOf } from '@shared/session/approvalDecision';
import { errorResult } from '@tools/core/result';
import { clamp, generateShortId } from '@utils/core';
import { readSettingFrom } from '@utils/config/platformSettings';
import { workspaceRelativePath } from '@utils/files/workspaceFS';
import {
  buildDiffHunks,
  reportDiffTimeout,
  unifiedDiffText,
  type DiffHunks,
} from '@utils/text/unifiedDiff';
import {
  countLines,
  isNonEmptyString,
  normalizeLineEndings,
} from '@utils/text/stringUtils';

const CHANNEL = 'ToolEditApproval';

/**
 * Tool-edit approval request / result shapes.
 *
 * The request reaches a host through `SessionHandle.interactions.presentToolEdit`
 * (the preview the durable payload cannot carry); the decision comes back as
 * the request's `request.decide`.
 */
export interface ToolEditApprovalRequest {
  readonly path: string;
  readonly originalContent: string;
  readonly proposedContent: string;
  readonly sourceTool: string;
  readonly runId?: RunId | null;
  /**
   * The session's workspace roots, as data: the LaTeX preview of this request
   * writes its temp files under the workspace and reads the diff's settings
   * from these slots, and that preview program runs on the host's own runner
   * rather than inside the tool call that raised the request, so the roots
   * have to travel with the request instead of being read from an ambient
   * workspace scope. {@link requestToolEditApproval} — the one producer of a
   * request — fills them from the run's session.
   */
  readonly roots: WorkspaceRoots;
  /**
   * What the UI shows for this request, prepared once at the tool boundary
   * (`prepareToolEditApprovalPrompt`): the payload of the `request.opened`
   * fact the session publishes, and what every host surface renders.
   */
  readonly permission: ToolEditPermission;
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
  | RequestRefusal;

export const REVEAL_TIMEOUT_MS = 1500;

/**
 * Build the tool-edit permission payload every host lists from the fold, the
 * tool-edit counterpart of `prepareBashApprovalPrompt`.
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
    request: Omit<ToolEditApprovalRequest, 'permission' | 'roots'>;
    relativePath: string;
  },
): { permission: ToolEditPermission; diffTimeout: string | undefined } {
  const { requestId, request, relativePath } = params;
  const { runId } = request;
  const isBypassed = runId
    ? session.approvals.toolEdit.bypass.isBypassed(runId)
    : false;
  const { hunks, timeout } = diffEdit(
    request.originalContent,
    request.proposedContent,
  );
  const lineChanges = countLineChanges(hunks);
  return {
    permission: {
      requestId,
      path: request.path,
      relativePath,
      sourceTool: request.sourceTool,
      allowBypass: !isBypassed,
      runId: runId ?? '',
      addedLines: lineChanges.added,
      removedLines: lineChanges.removed,
      isLatex: isLatexFile(request.path),
    },
    diffTimeout: timeout,
  };
}

// ============================================================================
// Pure diff helpers, shared with the hosts' native approval/diff surfaces
// ============================================================================

/** One diff pass over an edit; identical texts skip the engine entirely. */
function diffEdit(original: string, proposed: string): DiffHunks {
  return original === proposed
    ? { hunks: [], timeout: undefined }
    : buildDiffHunks(original, proposed);
}

/** Added/removed line counts folded over hunks a caller already holds. */
export function countLineChanges(hunks: DiffHunks['hunks']): LineChanges {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

/**
 * Added/removed line counts for an edit, folded from the very hunks the host
 * renders underneath them — the CLI card's `+N / −M` header and the diff body
 * below it are now two readings of one computation, not two engines.
 * The approval hosts call this (and {@link firstChangedLine}) on the pair
 * {@link requestToolEditApproval} already diffed and reported a timeout for,
 * so these re-readings do not report it again. A caller diffing a pair of its
 * own diffs it with `buildDiffHunks`, reports the timeout, and folds the hunks
 * with {@link countLineChanges}.
 */
export function computeLineChangeSummary(
  original: string,
  proposed: string,
): LineChanges {
  return countLineChanges(diffEdit(original, proposed).hunks);
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
  return firstChangedLineIn(diffEdit(original, proposed).hunks, proposed);
}

function firstChangedLineIn(
  hunks: DiffHunks['hunks'],
  proposed: string,
): number | null {
  const [hunk] = hunks;
  if (!hunk) return null;

  const lastProposedLine = Math.max(countLines(proposed) - 1, 0);
  let line = hunk.newStart;
  for (const text of hunk.lines) {
    const marker = text.at(0);
    if (marker === '+') return Math.min(line - 1, lastProposedLine);
    // A deletion has no line of its own in the proposed text; reveal the
    // position it was removed from.
    if (marker === '-') {
      return clamp(line - 1, 0, lastProposedLine);
    }
    line += 1;
  }
  return clamp(hunk.newStart - 1, 0, lastProposedLine);
}

// ============================================================================
// Approval queue and request handling
// ============================================================================

/**
 * Ask the person for an edit: policy first (allow, deny), else a
 * `request.opened` on the run with the preview staged on the attached host,
 * serialized behind the run's other prompts, answered by a surface's
 * `request.decide`. An approve carries the file as the user left it in the
 * host's diff view, or nothing when the host staged no preview.
 */
export const requestToolEditApproval = Effect.fn('requestToolEditApproval')(
  function* (
    request: Omit<ToolEditApprovalRequest, 'permission' | 'roots'>,
  ): Effect.fn.Return<ToolEditApprovalResult, Error, ToolCall> {
    const call = yield* ToolCall;
    const approvalsEnabled = yield* readSettingFrom<boolean>(
      call.roots,
      TOOL_EDIT_APPROVAL_CONFIG_KEY,
    );
    const run = call.run;
    if (!run) {
      return yield* Effect.fail(
        new Error('A tool-edit approval needs an active run.'),
      );
    }
    const { session } = run;
    const contextRunId = run.runId;
    const withRunId =
      request.runId || !contextRunId
        ? request
        : { ...request, runId: contextRunId };
    const preparedRequest: Omit<ToolEditApprovalRequest, 'permission'> = {
      ...withRunId,
      // Filled here, at the one boundary that has the run, so a caller cannot
      // hand the preview roots that are not this session's.
      roots: session.roots,
    };

    const runId = preparedRequest.runId ?? undefined;
    const isRunBypassed = Boolean(
      runId && session.approvals.toolEdit.bypass.isBypassed(runId),
    );
    const acceptProposedAsIs = (): Effect.Effect<ToolEditApprovalResult> =>
      finalizeApprovalResult(
        { action: 'apply', appliedContent: preparedRequest.proposedContent },
        preparedRequest,
      );
    const decision = decideTexraApproval({
      policy: session.approvalPolicy,
      promptRequired: approvalsEnabled,
      scopedBypass: isRunBypassed,
      canPresent: run.toolPolicy.approvalPromptsUnavailable !== true,
    });
    if (decision === 'allow') return yield* acceptProposedAsIs();
    if (isTexraApprovalDenied(decision)) {
      run.onApprovalPolicyDenial?.();
      return { action: 'deny', reason: texraApprovalDenialMessage(decision) };
    }
    if (!runId) {
      return yield* Effect.fail(
        new Error('A tool-edit approval needs a run to open its request on.'),
      );
    }

    const { permission, diffTimeout } = prepareToolEditApprovalPrompt(session, {
      requestId: `approval-${generateShortId()}`,
      request: preparedRequest,
      // The call's own workspace root, as data: the display path a host shows
      // is relative to the session that raised the request, not to whichever
      // roots the answering fiber happens to carry.
      relativePath: workspaceRelativePath(
        call.roots.workspace,
        preparedRequest.path,
      ),
    });
    yield* reportDiffTimeout(diffTimeout);
    const staged: ToolEditApprovalRequest = { ...preparedRequest, permission };
    return yield* session.approvals.toolEdit.enqueue(runId, {
      // The preview is staged before the request opens, and stays staged
      // until that request's `request.decided` releases it on every host:
      // a surface reading the committed row must never find the request
      // listed with nothing to show for it. Staging hands back the release
      // for what it staged, bound to the host it staged on; the one case no
      // decision ever reaches is an open that never committed, which
      // `openRequest` owns and runs this for.
      prompt: session.interactions.presentToolEdit(staged).pipe(
        Effect.flatMap((releaseStaged) =>
          session
            .openRequest(
              runId,
              { kind: 'toolEdit', data: permission },
              {
                // The host's own cleanup program, composed into the open:
                // this call waits for it, and a host that fails to release
                // says so here rather than through the refusal this tool
                // reports, so cleanup never masks the caller's outcome.
                onNeverCommitted: releaseStaged
                  ? releaseStaged.pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          `Failed to release the tool-edit preview staged for request ${permission.requestId}`,
                        ).pipe(
                          Effect.annotateLogs({ data: Cause.squash(cause) }),
                          withLogChannel(CHANNEL),
                        ),
                      ),
                    )
                  : Effect.void,
              },
            )
            .pipe(
              Effect.flatMap((decided) => {
                if (decided.action !== 'approve') {
                  return Effect.succeed(refusalOf('toolEdit', decided));
                }
                return finalizeApprovalResult(
                  {
                    action: 'apply',
                    appliedContent: normalizeLineEndings(
                      decided.content ?? preparedRequest.proposedContent,
                    ),
                  },
                  preparedRequest,
                );
              }),
            ),
        ),
      ),
      bypassed: Effect.suspend(acceptProposedAsIs),
    });
  },
);

function finalizeApprovalResult(
  result: ToolEditApprovalResult,
  request: Omit<ToolEditApprovalRequest, 'permission'>,
): Effect.Effect<ToolEditApprovalResult> {
  if (result.action !== 'apply') {
    return Effect.succeed(result);
  }

  const { appliedContent } = result;
  // One pass answers both the start line and the counts.
  const { hunks, timeout } = diffEdit(request.originalContent, appliedContent);

  // Compute startLine once here (convert 0-based to 1-based; null → line 1).
  const startLine = (firstChangedLineIn(hunks, appliedContent) ?? 0) + 1;

  return reportDiffTimeout(timeout).pipe(
    Effect.as({
      ...result,
      lineChanges: result.lineChanges ?? countLineChanges(hunks),
      startLine,
    }),
  );
}

/** The `action: 'apply'` branch of {@link ToolEditApprovalResult}. */
export type AcceptedToolEditApprovalResult = Extract<
  ToolEditApprovalResult,
  { action: 'apply' }
>;

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
  refusal: RequestRefusal,
): ToolResult {
  const copy = refusalCopy('Tool edit', refusal);
  const summary =
    refusal.action === 'reject'
      ? `User rejected ${sourceTool} for ${path}.`
      : `${copy.summary}: ${sourceTool} for ${path}.`;
  const details = [copy.detail].filter(isNonEmptyString);
  const error =
    details.length > 0 ? `${summary}\n\n${details.join('\n')}` : summary;
  return errorResult(error, {
    summary,
    ...(copy.feedback && { userInstruction: copy.feedback }),
  });
}
