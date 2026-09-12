import { Effect } from 'effect';

import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { ToolCall } from '@agent/runtime/ToolCall';
import { isLatexFile } from '@common/files/fileTypeUtils';
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
import { recordToolFileRead } from '@tools/fileInteractions';
import { errorResult } from '@tools/core/result';
import { clamp, generateShortId } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { getConfig } from '@utils/config/configUtils';
import { applyPatchToText } from '@utils/text/diff';
import { buildDiffHunks, unifiedDiffText } from '@utils/text/unifiedDiff';
import {
  countLines,
  isNonEmptyString,
  normalizeLineEndings,
} from '@utils/text/stringUtils';

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
      readonly userPatch?: string;
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
    request: Omit<ToolEditApprovalRequest, 'permission'>;
    relativePath: string;
  },
): ToolEditPermission {
  const { requestId, request, relativePath } = params;
  const { runId } = request;
  const isBypassed = runId
    ? session.approvals.toolEdit.bypass.isBypassed(runId)
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
    runId: runId ?? '',
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
    request: Omit<ToolEditApprovalRequest, 'permission'>,
  ): Effect.fn.Return<ToolEditApprovalResult, Error, ToolCall> {
    const call = yield* ToolCall;
    const approvalsEnabled = call.inScope(() =>
      getConfig<boolean>(TOOL_EDIT_APPROVAL_CONFIG_KEY),
    );
    const run = call.run;
    if (!run) {
      return yield* Effect.fail(
        new Error('A tool-edit approval needs an active run.'),
      );
    }
    const { session } = run;
    const contextRunId = run.runId;
    const preparedRequest =
      request.runId || !contextRunId
        ? request
        : { ...request, runId: contextRunId };

    const runId = preparedRequest.runId ?? undefined;
    const isRunBypassed = Boolean(
      runId && session.approvals.toolEdit.bypass.isBypassed(runId),
    );
    const acceptProposedAsIs = (): ToolEditApprovalResult =>
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
    if (decision === 'allow') return acceptProposedAsIs();
    if (isTexraApprovalDenied(decision)) {
      call.onApprovalPolicyDenial?.();
      return { action: 'deny', reason: texraApprovalDenialMessage(decision) };
    }
    if (!runId) {
      return yield* Effect.fail(
        new Error('A tool-edit approval needs a run to open its request on.'),
      );
    }

    const permission = prepareToolEditApprovalPrompt(session, {
      requestId: `approval-${generateShortId()}`,
      request: preparedRequest,
      relativePath: call.inScope(() =>
        WorkspaceFS.relativePath(preparedRequest.path),
      ),
    });
    const staged: ToolEditApprovalRequest = { ...preparedRequest, permission };
    return yield* session.approvals.toolEdit.enqueue(runId, {
      // The preview is staged before the request opens, and stays staged
      // until that request's `request.decided` releases it on every host:
      // a surface reading the committed row must never find the request
      // listed with nothing to show for it. An interrupted open closes the
      // request as cancelled, which is the release.
      prompt: Effect.suspend(() => {
        call.inScope(() => session.interactions.presentToolEdit(staged));
        return session
          .openRequest(runId, { kind: 'toolEdit', data: permission })
          .pipe(
            Effect.map((decided): ToolEditApprovalResult => {
              if (decided.action !== 'approve') {
                return refusalOf('toolEdit', decided);
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
          );
      }),
      bypassed: Effect.sync(acceptProposedAsIs),
    });
  },
);

function finalizeApprovalResult(
  result: ToolEditApprovalResult,
  request: Omit<ToolEditApprovalRequest, 'permission'>,
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
export const writeApprovedContent = Effect.fn('writeApprovedContent')(
  function* (
    path: string,
    originalContent: string,
    finalContent: string,
  ): Effect.fn.Return<WriteApprovedContentResult, unknown, ToolCall> {
    const call = yield* ToolCall;
    const exists = yield* Effect.tryPromise({
      try: () => call.inScope(() => WorkspaceFS.exists(path)),
      catch: (cause) => cause,
    });
    let baseContent = '';
    let appliedContent = finalContent;
    let shouldWrite = true;

    if (exists) {
      // All content is already LF-normalized at the FS read boundary,
      // so comparisons work directly without extra normalization.
      const currentContent = yield* Effect.tryPromise({
        try: () => call.inScope(() => WorkspaceFS.read(path)),
        catch: (cause) => cause,
      });
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
      yield* Effect.tryPromise({
        try: () => call.inScope(() => WorkspaceFS.write(path, appliedContent)),
        catch: (cause) => cause,
      });
    }
    yield* recordToolFileRead(path);
    return { appliedContent, baseContent };
  },
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
): string {
  const diffBody = unifiedDiffText(proposedContent, appliedContent);
  return diffBody
    ? `${baseOutput}\n\nUser adjustments to ${path}:\n\n\`\`\`diff\n${diffBody}\n\`\`\``
    : baseOutput;
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
