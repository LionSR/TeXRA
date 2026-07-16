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

  if (!approvalPromptAllowed(context)) {
    const feedback = humanInputDenialFeedback(
      context,
      'External inquiry requires human input; yolo mode cannot synthesize an external answer.',
    );
    void handleExternalInquiryAction({ action: 'drop', threadId, feedback });
    return;
  }

  void handleExternalInquiryAction({
    action: 'drop',
    threadId,
    feedback: NON_TUI_EXTERNAL_INQUIRY_FEEDBACK,
  });
}
