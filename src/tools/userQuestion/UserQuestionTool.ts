import { z } from 'zod';

import { createChannelTrace } from '@agent/trace';
import {
  getRunContextSession,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  UserQuestionAnswersSchema,
  UserQuestionPromptSchema,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas';
import { requireInteractions } from '@tools/contextHelpers';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { generateShortId } from '@utils/core';

const logger = createChannelTrace('UserQuestionTool');

const AskUserQuestionInputSchema = z.strictObject({
  questions: z
    .array(UserQuestionPromptSchema)
    .min(1)
    .max(3)
    .describe(
      'One to three questions for the user. Keep each question short and provide two to four clear options.',
    ),
  context: z
    .string()
    .nullish()
    .describe('Optional short context explaining why the answer is needed.'),
});

type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

export class AskUserQuestionTool extends defineTool({
  name: 'ask_user_question',
  requiresApproval: true,
  description: `Ask the user one to three short clarification questions and wait for their answers.

Use this when the task has several reasonable paths and continuing without the user's preference would be guesswork. Provide two to four concrete options for each question. Use allowFreeText only when the listed options may not cover the user's answer.

The tool returns a JSON object whose keys are the original question texts and whose values are the selected option labels, arrays of labels for multi-select questions, or free-text answers.`,
  schema: AskUserQuestionInputSchema,
}) {
  protected async execute(input: AskUserQuestionInput): Promise<ToolResult> {
    const context = tryUseRunContext();
    requireInteractions('ask_user_question', context);
    const streamId = getRunContextStreamId(context);
    const requestId = `user-question-${generateShortId()}`;

    logger.info('User question requested', {
      data: input.questions[0]?.question.slice(0, 100) ?? '',
    });

    const permission = {
      requestId,
      questions: input.questions,
      context: input.context ?? undefined,
      allowBypass: false,
      streamId: streamId ?? '',
    };
    const session = getRunContextSession(context) ?? defaultSession();
    const result = await session.interactions.askUserQuestion(permission);

    if (result.action !== 'submit') {
      if ('cause' in result) {
        return executed(
          result.cause
            ? `The user question was cancelled: ${result.cause}`
            : 'The user question was cancelled.',
        );
      }
      if ('reason' in result) {
        return executed(
          result.reason
            ? `The user question was denied: ${result.reason}`
            : 'The user question was denied.',
        );
      }
      return executed(
        result.feedback
          ? `The user declined to answer: ${result.feedback}`
          : 'The user declined to answer.',
      );
    }

    const answers = UserQuestionAnswersSchema.parse(result.answers);
    if (Object.keys(answers).length === 0) {
      return executed('The user submitted no answers.');
    }

    return executed(
      JSON.stringify({ answers }, null, 2),
      `Answered ${Object.keys(answers).length} user question(s).`,
    );
  }
}
