/**
 * `executions send`: put a message on another run's input, the way a
 * terminal session types into another pane. The one verb for every
 * run-to-run message: an orchestrator's follow-up to its subagent, a
 * subagent's note to its orchestrator, a peer's message to a sibling. A
 * child's automatic report rides the same row (`childRunLoop`), so the
 * recipient reads every one of them the same way, at its next turn boundary.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import {
  describeFollowUpFailure,
  FOLLOW_UP_WAKE_FAILED_MESSAGE,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { senderOf } from '@agent/followUp/followUpSender';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentCategory,
  ToolError,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
} from '@shared/schemas';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { executed } from '@tools/core/result';
import { previewLabel } from '@utils/text/stringUtils';

/**
 * Send `message` from the calling run to `target` (from the user when no
 * run calls). Any run may message any run in the project, whatever their
 * places in the supervision tree, and a message to a parked or waiting run
 * wakes it. A run the user stopped is not revived by a run's message: that
 * is refused, and only the user's own message continues it.
 */
export const sendToRun = Effect.fn('ExecutionsTool.send')(function* (
  session: SessionHandle,
  caller: RunId | undefined,
  target: RunId,
  message: string,
) {
  if (target === caller) {
    return yield* Effect.fail(
      new ToolError('A run cannot send a message to itself.'),
    );
  }
  const view = yield* session.readView([]);
  const recipient = view.runs.get(target);
  if (!recipient) {
    return yield* Effect.fail(
      new ToolError(
        `Run '${target}' not found. Use the executions tool to list runs.`,
      ),
    );
  }
  if (recipient.category !== AgentCategory.ToolUse) {
    return yield* Effect.fail(
      new ToolError(
        `Run '${target}' is a workflow agent. Only tool-use runs take messages.`,
      ),
    );
  }
  // A one-shot run (headless, or an in-band child) ends after its current
  // turn and has no next boundary to read a message at: one queued here would
  // sit unread under a "sent" acknowledgement. Refused, as every host refuses
  // the user's follow-up to it (`acceptsFollowUp`).
  if (recipient.followUpSupport === USER_FOLLOW_UP_SUPPORT.UNSUPPORTED) {
    return yield* Effect.fail(
      new ToolError(
        `Run '${target}' is a one-shot run: it ends after its current turn and reads no messages. Put what it needs in your own result instead.`,
      ),
    );
  }
  const sender =
    caller === undefined
      ? 'the user'
      : (view.runs.get(caller)?.label ?? caller);
  const text = [
    `<run-message from="${escapeAttr(caller ?? 'user')}" agent="${escapeAttr(sender)}">`,
    escapeText(message),
    '</run-message>',
  ].join('\n');
  const result = yield* submitFollowUp(
    target,
    {
      text,
      displayText: `Message from ${sender}: ${previewLabel(message)}`,
      from: senderOf(caller),
    },
    { session },
  );
  const name = `'${recipient.label}' (${target})`;
  if (result.status === 'failed') {
    return yield* Effect.fail(
      new ToolError(
        `${name} did not accept the message (${result.reason}): ${describeFollowUpFailure(result.reason)}`,
      ),
    );
  }
  if (result.status === 'queued' && result.wake === 'failed') {
    return executed(
      `Message queued for ${name}, but the run could not be resumed. ${FOLLOW_UP_WAKE_FAILED_MESSAGE}`,
      `Message queued for '${recipient.label}' (resume failed)`,
    );
  }
  const verb = result.status === 'sent' ? 'Sent' : 'Queued';
  return executed(
    `${verb} to ${name}. It reads the message at its next turn boundary. A reply, if any, arrives as your own follow-up; use action: "wait" to block on it.`,
    `${verb} message to '${recipient.label}'`,
  );
});
