import { Cause, Effect } from 'effect';

import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { requireRun, sessionOf } from '@agent/runtime/RunCall';
import { ToolContext } from '@agent/core/tools/ToolTypes';
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  decideApproval,
  isApprovalDenied,
  approvalPolicyDenialMessage,
} from '@shared/approvalPolicy';
import {
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
  type RefusalDecision,
  type RunId,
  type ToolEditPermission,
  type ToolResult,
} from '@shared/schemas';
import { refusalCopy, refusalOf } from '@shared/session/approvalDecision';
import type { ToolEditContent } from '@shared/session/runtimeRequest';
import { Settings } from '@shared/config/settings';
import { errorResult } from '@tools/core/result';
import { workspaceRelativePath } from '@utils/files/workspaceFS';
import {
  buildDiffHunks,
  countLineChanges,
  firstChangedLine,
  reportDiffTimeout,
  unifiedDiffText,
  type DiffHunks,
} from '@utils/text/unifiedDiff';

const CHANNEL = 'ToolEditApproval';

/**
 * Tool-edit approval request / result shapes.
 *
 * The request reaches a host through `SessionHandle.interactions.presentToolEdit`
 * (the preview the durable payload cannot carry); the decision comes back as
 * the request's `request.decide`. Its content carries the diff a host shows
 * (hunks, the first changed line), computed here once; the line counts are
 * the permission's.
 */
export interface ToolEditApprovalRequest extends ToolEditContent {
  readonly path: string;
  readonly sourceTool: string;
  readonly runId?: RunId | null;
  /**
   * The session's workspace roots, as data: a host's preview of this request
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
  | RefusalDecision;

/** What a tool proposes; {@link requestToolEditApproval} derives the rest. */
export type ToolEditProposal = Omit<
  ToolEditApprovalRequest,
  'permission' | 'roots' | 'hunks' | 'firstChangedLine'
>;

/**
 * Build the tool-edit permission payload every host lists from the fold, the
 * tool-edit counterpart of `prepareBashApprovalPrompt`.
 *
 * Owning it here gives one bypass-affordance derivation and one diff pass
 * (the hunks, their line counts and the first changed line), so the TUI's
 * inline card and the webview panel cannot report different numbers for the
 * same edit. The host supplies the `requestId` it tracks the request under
 * and the display path it shows; revealing the host's approval surface
 * belongs to the caller, not to this projection — a host with no separate
 * view has nothing to reveal.
 */
export function prepareToolEditApprovalPrompt(
  session: SessionHandle,
  params: {
    requestId: string;
    request: ToolEditProposal;
    relativePath: string;
  },
): Pick<
  ToolEditApprovalRequest,
  'permission' | 'hunks' | 'firstChangedLine'
> & {
  diffTimeout: string | undefined;
} {
  const { requestId, request, relativePath } = params;
  const { runId } = request;
  const isBypassed =
    runId != null && session.approvals.bypass(runId, 'toolEdit') !== null;
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
    },
    hunks,
    firstChangedLine: firstChangedLine(hunks, request.proposedContent),
    diffTimeout: timeout,
  };
}

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
 * Ask the person for an edit: policy first (allow, deny), else a
 * `request.opened` on the run with the preview staged on the attached host,
 * serialized behind the run's other prompts, answered by a surface's
 * `request.decide`. An approve carries the file as the user left it in the
 * host's diff view, or nothing when the host staged no preview.
 */
export const requestToolEditApproval = Effect.fn('requestToolEditApproval')(
  function* (
    request: ToolEditProposal,
  ): Effect.fn.Return<ToolEditApprovalResult, Error, ToolContext> {
    const call = yield* requireRun('A tool-edit approval');
    const approvalsEnabled = yield* Settings.get<boolean>(
      call.env.roots,
      TOOL_EDIT_APPROVAL_CONFIG_KEY,
    );
    const { run, requests } = call;
    const session = sessionOf(run);
    const contextRunId = run.runId;
    const withRunId =
      request.runId || !contextRunId
        ? request
        : { ...request, runId: contextRunId };
    const preparedRequest: ToolEditProposal &
      Pick<ToolEditApprovalRequest, 'roots'> = {
      ...withRunId,
      // Filled here, at the one boundary that has the run, so a caller cannot
      // hand the preview roots that are not this session's.
      roots: session.roots,
    };

    const runId = preparedRequest.runId ?? undefined;
    const isRunBypassed =
      runId !== undefined &&
      session.approvals.bypass(runId, 'toolEdit') !== null;
    const acceptProposedAsIs = (): Effect.Effect<ToolEditApprovalResult> =>
      finalizeApprovalResult(preparedRequest.proposedContent, preparedRequest);
    const policy = session.approvals.policy(runId);
    const decision = decideApproval({
      policy,
      promptRequired: approvalsEnabled,
      scopedBypass: isRunBypassed,
      canPresent: !session.interactions.approvalPromptsUnavailable,
    });
    if (decision === 'allow') return yield* acceptProposedAsIs();
    if (isApprovalDenied(decision)) {
      session.interactions.approvalDenied(
        { kind: 'executable', policy },
        run.runId,
      );
      return { action: 'deny', reason: approvalPolicyDenialMessage(decision) };
    }
    if (!runId) {
      return yield* Effect.fail(
        new Error('A tool-edit approval needs a run to open its request on.'),
      );
    }

    const { diffTimeout, ...prompt } = prepareToolEditApprovalPrompt(session, {
      requestId: requests.nextId('toolEdit'),
      request: preparedRequest,
      // The call's own workspace root, as data: the display path a host shows
      // is relative to the session that raised the request, not to whichever
      // roots the answering fiber happens to carry.
      relativePath: workspaceRelativePath(
        call.env.roots.workspace,
        preparedRequest.path,
      ),
    });
    yield* reportDiffTimeout(diffTimeout);
    const staged: ToolEditApprovalRequest = { ...preparedRequest, ...prompt };
    const { permission } = prompt;
    return yield* session.approvals.enqueue('toolEdit', runId, {
      // The preview is staged before the request opens, and stays staged
      // until that request's `request.decided` releases it on every host:
      // a surface reading the committed row must never find the request
      // listed with nothing to show for it. Staging hands back the release
      // for what it staged, bound to the host it staged on; the one case no
      // decision ever reaches is an open that never committed, which
      // `requests.ask` owns and runs this for.
      prompt: session.interactions.presentToolEdit(staged).pipe(
        Effect.flatMap((releaseStaged) =>
          requests
            .open(
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
              Effect.flatMap(
                (decided): Effect.Effect<ToolEditApprovalResult> => {
                  if (decided.action !== 'approve') {
                    return Effect.succeed(refusalOf('toolEdit', decided));
                  }
                  return finalizeApprovalResult(
                    (
                      decided.content ?? preparedRequest.proposedContent
                    ).replaceAll('\r\n', '\n'),
                    preparedRequest,
                  );
                },
              ),
            ),
        ),
      ),
      bypassed: Effect.suspend(acceptProposedAsIs),
    });
  },
);

function finalizeApprovalResult(
  appliedContent: string,
  request: ToolEditProposal,
): Effect.Effect<AcceptedToolEditApprovalResult> {
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

/** The tool result the model gets when the user rejects or cancels a file edit's approval. */
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
