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
  presentFollowUpResult,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { senderOf } from '@agent/followUp/followUpMessages';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { ToolError, type RunId } from '@shared/schemas';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { executed } from '@tools/core/result';
import { previewLabel } from '@utils/text/stringUtils';

/**
 * The refusal for a run the view does not hold: `notFound`, unless it was
 * launched here and has not opened yet (it is born with its opening, so it
 * has no rows, but it is no unknown run).
 */
export const missingRun = (
  session: SessionHandle,
  runId: RunId,
  notFound: string,
): ToolError =>
  new ToolError(
    session.runs.get(runId) !== undefined
      ? `Run '${runId}' has not started yet; retry in a moment.`
      : notFound,
  );

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
  const view = yield* session.view.read([]);
  const recipient = view.runs.get(target);
  if (!recipient)
    return yield* Effect.fail(
      missingRun(
        session,
        target,
        `Run '${target}' not found. Use the executions tool to list runs.`,
      ),
    );
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
  const shown = presentFollowUpResult(result);
  if (shown.severity === 'warning') {
    return yield* Effect.fail(
      new ToolError(`${name} did not accept the message: ${shown.message}`),
    );
  }
  if (shown.severity === 'info') {
    return executed(
      `Message queued for ${name}. ${shown.message}`,
      `Message queued for '${recipient.label}' (resume failed)`,
    );
  }
  const verb = result.status === 'sent' ? 'Sent' : 'Queued';
  return executed(
    `${verb} to ${name}. It reads the message before its next model request, or at its next turn boundary. A reply, if any, arrives as your own follow-up; use action: "wait" to block on it.`,
    `${verb} message to '${recipient.label}'`,
  );
});
