import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

import { type CliContext } from '../cliContext';

import {
  type CliApprovalPromptHooks,
  approvalPromptAllowed,
  humanInputDenialFeedback,
} from './approvalPolicy';

const NON_TUI_EXTERNAL_INQUIRY_FEEDBACK =
  'External inquiry is not available in non-TUI CLI runs: inquiry answers ' +
  'are delivered as asynchronous continuations, and this process cannot ' +
  'resume them after the run finalizes. Use texra chat for the inquiry ' +
  'panel, or ask_user_question for synchronous CLI input.';

const EXTERNAL_INQUIRY_YOLO_MESSAGE =
  'External inquiry requires human input; yolo mode cannot synthesize an external answer.';

/**
 * Shared "no human input available" guard for external-inquiry requests,
 * used by both the non-TUI handler below and the TUI approval queue. Drops
 * the durable inquiry thread with denial feedback and returns `true` when
 * denied; returns `false` when a prompt is allowed and the caller should
 * proceed with its own (TUI vs. non-TUI) handling.
 */
export function denyExternalInquiryIfNoHumanInput(
  threadId: string,
  context: CliContext,
): boolean {
  if (approvalPromptAllowed(context)) return false;
  const feedback = humanInputDenialFeedback(
    context,
    EXTERNAL_INQUIRY_YOLO_MESSAGE,
  );
  void handleExternalInquiryAction({ action: 'drop', threadId, feedback });
  return true;
}

export function handleExternalInquiry(
  payload: RuntimeInteractionEventPayloads['showExternalInquiry'],
  context: CliContext,
  _hooks: CliApprovalPromptHooks = {},
): void {
  const threadId = payload.threadId;
  if (!threadId) {
    // No persistent thread to address — pre-async legacy payload. Ignore.
    return;
  }

  if (denyExternalInquiryIfNoHumanInput(threadId, context)) return;

  void handleExternalInquiryAction({
    action: 'drop',
    threadId,
    feedback: NON_TUI_EXTERNAL_INQUIRY_FEEDBACK,
  });
}
