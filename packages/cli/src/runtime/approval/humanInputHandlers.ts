import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import type { UserQuestionSettlement } from '@agent/runtime/HostInteractions';

import { handleUserQuestionAction } from '@tools/userQuestion';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

import { type CliContext } from '../cliContext';
import { parseUserQuestionAnswer } from '../userQuestionAnswer';

import {
  type CliApprovalPromptHooks,
  approvalPromptAllowed,
  humanInputDenialFeedback,
  markApprovalDenied,
  queueCliApprovalQuestion,
} from './approvalPolicy';
import { formatUserQuestionPrompt } from './approvalSummaries';

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

export function handleUserQuestion(
  payload: RuntimeInteractionEventPayloads['showUserQuestion'],
  context: CliContext,
  hooks: CliApprovalPromptHooks = {},
): void {
  if (!approvalPromptAllowed(context)) {
    const feedback = humanInputDenialFeedback(
      context,
      'User question requires human input; yolo mode cannot synthesize an answer.',
    );
    void handleUserQuestionAction({
      requestId: payload.requestId,
      action: 'skip',
      feedback,
    });
    return;
  }

  void (async () => {
    const answers: Record<string, string | string[]> = {};
    try {
      for (const question of payload.questions) {
        hooks.beforePrompt?.();
        const answer = await queueCliApprovalQuestion(context, {
          kind: 'approval',
          summary: payload.context
            ? `${payload.context}\n\n${formatUserQuestionPrompt({
                ...payload,
                questions: [question],
              })}`
            : formatUserQuestionPrompt({ ...payload, questions: [question] }),
          prompt: 'Answer (blank to skip): ',
        });
        const parsed = parseUserQuestionAnswer(answer, question);
        if (parsed != null) answers[question.question] = parsed;
      }
    } catch {
      markApprovalDenied(context);
      await handleUserQuestionAction({
        requestId: payload.requestId,
        action: 'skip',
        feedback: 'CLI user question prompt failed.',
      });
      return;
    }

    const submitted = Object.keys(answers).length > 0;
    const decision: UserQuestionSettlement = submitted
      ? { action: 'submit', answers }
      : { action: 'skip', feedback: 'User question skipped by user.' };
    await handleUserQuestionAction({
      requestId: payload.requestId,
      ...decision,
    });
  })();
}
