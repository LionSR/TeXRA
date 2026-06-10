import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import { handleUserQuestionAction } from '@tools/userQuestion';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

import { type CliContext } from '../cliContext';
import { parseUserQuestionAnswer } from '../userQuestionAnswer';

import {
  approvalPromptAllowed,
  humanInputDenialFeedback,
  markApprovalDenied,
  queueCliApprovalQuestion,
} from './approvalPolicy';
import { formatUserQuestionPrompt } from './approvalSummaries';

export function handleExternalInquiry(
  payload: ProgressEventPayloads['showExternalInquiry'],
  context: CliContext,
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

  void (async () => {
    let answer: string;
    try {
      answer = await queueCliApprovalQuestion(context, {
        kind: 'externalInquiry',
        summary: `External inquiry requested:\n${payload.question}`,
        prompt: 'Answer (blank to skip): ',
      });
    } catch {
      markApprovalDenied(context);
      await handleExternalInquiryAction({
        action: 'drop',
        threadId,
        feedback: 'CLI external inquiry prompt failed.',
      });
      return;
    }

    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      await handleExternalInquiryAction({
        action: 'drop',
        threadId,
        feedback: 'External inquiry skipped by user.',
      });
      return;
    }
    await handleExternalInquiryAction({
      action: 'submit',
      threadId,
      answer: trimmed,
    });
  })();
}

export function handleUserQuestion(
  payload: ProgressEventPayloads['showUserQuestion'],
  context: CliContext,
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
    await handleUserQuestionAction({
      requestId: payload.requestId,
      action: submitted ? 'submit' : 'skip',
      answers: submitted ? answers : undefined,
      feedback: submitted ? undefined : 'User question skipped by user.',
    });
  })();
}
