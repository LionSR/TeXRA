// Single policy owner for media/tool-attachment failures (#7465).
//
// Before this module, ~15 call sites across src/agent/modelHandlers/ each
// re-derived their own answer to "what happens when a file attachment fails
// to load/encode/upload?" — some let the error propagate and fail the whole
// run, others caught it, warned, and silently dropped the attachment. The
// same user action (attach a file) could silently vanish or blow up the run
// depending on which code path happened to touch it, with no single place
// that decided the policy on purpose.
//
// This module is that single place. Every one of the former per-site
// catches now funnels through `reportMediaAttachmentFailure` (or the
// `ModelHandler.createMediaForRound` wrapper built on top of it), so the
// fail-vs-warn decision is made once, per attachment context, and is
// trivial to audit or change in one spot.
import { logSdkError } from '@agent/trace';
import type { AgentTrace } from '@agent/trace';
import {
  getSdkErrorMessage,
} from '@common/errors/sdkError/providerErrorFormat';

/**
 * Context a media/tool-attachment failure occurred in:
 *  - `initial`: building the first message of a run. The user's opening
 *    request can't be honored as attached, so the failure fails the round
 *    loudly (thrown, same as any other genuine model-request build error).
 *  - `followUp`: building a subsequent conversation round's message.
 *  - `insert`: attaching media into an already-built message mid-conversation
 *    (paste-to-attach).
 *  - `toolAttachment`: encoding/uploading a *tool result's* file attachment
 *    for inclusion in the model-facing tool response.
 *
 * `followUp`, `insert`, and `toolAttachment` all continue without the
 * attachment rather than failing the round — an already-running
 * conversation, or a tool call that already produced other useful output,
 * shouldn't die over one bad attachment — but they don't all log at the same
 * severity (see `CONTEXT_SEVERITY` below): the prior per-site behavior this
 * module replaces was itself split between warn and error, and this policy
 * carries that distinction forward deliberately rather than flattening it.
 * They stay distinct context labels (rather than collapsing to one) because
 * the label is what lands in the emitted trace message, and because a future
 * change to this policy (e.g. making `toolAttachment` failures stricter)
 * should be a one-line change to `shouldFailRound`/`CONTEXT_SEVERITY`, not a
 * re-audit of every call site.
 */
export type MediaAttachmentContext =
  'initial' | 'followUp' | 'insert' | 'toolAttachment';

/** The only place that decides fail-vs-warn for a media/attachment failure. */
function shouldFailRound(
  context: MediaAttachmentContext,
): context is 'initial' {
  return context === 'initial';
}

const CONTEXT_LABEL: Record<MediaAttachmentContext, string> = {
  initial: 'initial message',
  followUp: 'follow-up round',
  insert: 'mid-conversation attachment',
  toolAttachment: 'tool result attachment',
};

/**
 * The severity each non-`initial` context logged at before this module
 * existed. `toolAttachment` call sites (e.g. `anthropicTools.ts`'s upload
 * loop) used `logger.warn` — a transient upload-service hiccup on one
 * attachment is expected to be common enough that it shouldn't render as a
 * red error in the progress view. `followUp`/`insert` sites more often
 * already used the error-level `logSdkError`. Preserved here rather than
 * flattened to one level, so centralizing the policy doesn't silently
 * escalate a warning-worthy failure into an error-worthy one.
 */
const CONTEXT_SEVERITY: Record<
  Exclude<MediaAttachmentContext, 'initial'>,
  'warn' | 'error'
> = {
  followUp: 'error',
  insert: 'error',
  toolAttachment: 'warn',
};

const CONTEXT_OPERATION: Record<MediaAttachmentContext, string> = {
  initial: 'process media files',
  followUp: 'process media files',
  insert: 'process media files',
  toolAttachment: 'upload tool attachment',
};

/**
 * Report a media/tool-attachment failure per the single policy above.
 * `initial` throws (propagates to the caller's existing SDK-error handling,
 * failing the round loudly); every other context emits one consistently
 * formatted trace entry, at the severity `CONTEXT_SEVERITY` records for it,
 * and returns, so the caller degrades to "continue without this attachment".
 */
export function reportMediaAttachmentFailure(
  logger: AgentTrace,
  context: MediaAttachmentContext,
  err: unknown,
  detail?: string,
): void {
  if (shouldFailRound(context)) {
    throw err instanceof Error ? err : new Error(getSdkErrorMessage(err));
  }
  const suffix = detail ? ` (${detail})` : '';
  const message = `Error processing media for ${CONTEXT_LABEL[context]}${suffix}`;
  const operation = CONTEXT_OPERATION[context];
  if (CONTEXT_SEVERITY[context] === 'warn') {
    logger.warn(message, {
      data: { operation, error: getSdkErrorMessage(err) },
    });
    return;
  }
  logSdkError(logger, message, err, { operation });
}
