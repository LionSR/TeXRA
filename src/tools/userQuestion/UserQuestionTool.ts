import { Effect } from 'effect';
import { z } from 'zod';

import { ToolCall } from '@agent/runtime/ToolCall';
import { createLog } from '@logger/logUtils';
import {
  ToolError,
  UserQuestionAnswersSchema,
  UserQuestionPromptSchema,
} from '@shared/schemas';
import type { ToolResult, UserQuestionPermission } from '@shared/schemas';
import { refusalOf } from '@shared/session/approvalDecision';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { generateShortId } from '@utils/core';

const logger = createLog('UserQuestionTool');

/** `"<base>: <detail>"` when a detail exists, else `"<base>."` */
function withDetail(base: string, detail: string | undefined): string {
  return detail ? `${base}: ${detail}` : `${base}.`;
}

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

const askUserQuestion = Effect.fn('AskUserQuestionTool.execute')(function* (
  input: AskUserQuestionInput,
) {
  const call = yield* ToolCall;
  const run = call.run;
  if (!run) {
    return yield* Effect.fail(
      new ToolError('ask_user_question requires an active run context.'),
    );
  }
  const { runId, session } = run;
  const requestId = `user-question-${generateShortId()}`;

  logger.info('User question requested', {
    data: input.questions[0]?.question.slice(0, 100) ?? '',
  });

  const permission: UserQuestionPermission = {
    requestId,
    questions: input.questions,
    context: input.context ?? undefined,
    allowBypass: false,
    runId,
  };
  const decision = yield* session.openRequest(runId, {
    kind: 'userQuestion',
    data: permission,
  });

  if (decision.action === 'skip') {
    return executed(
      withDetail('The user declined to answer', decision.feedback ?? undefined),
    );
  }
  if (decision.action !== 'submit') {
    const refusal = refusalOf('userQuestion', decision);
    switch (refusal.action) {
      case 'cancel':
        return executed(
          withDetail(
            'The user question was cancelled',
            refusal.cause ?? undefined,
          ),
        );
      case 'deny':
        return executed(
          withDetail('The user question was denied', refusal.reason),
        );
      case 'reject':
        return executed(
          withDetail(
            'The user declined to answer',
            refusal.feedback ?? undefined,
          ),
        );
    }
  }

  const answers = UserQuestionAnswersSchema.parse(decision.answers);
  const answerCount = Object.keys(answers).length;
  if (answerCount === 0) {
    return executed('The user submitted no answers.');
  }

  return executed(
    JSON.stringify({ answers }, null, 2),
    `Answered ${answerCount} user question(s).`,
  );
});

export const AskUserQuestionTool = defineTool({
  name: 'ask_user_question',
  requiresApproval: true,
  description: `Ask the user one to three short clarification questions and wait for their answers.

Use this when the task has several reasonable paths and continuing without the user's preference would be guesswork. Provide two to four concrete options for each question. Use allowFreeText only when the listed options may not cover the user's answer.

The tool returns a JSON object whose keys are the original question texts and whose values are the selected option labels, arrays of labels for multi-select questions, or free-text answers.`,
  schema: AskUserQuestionInputSchema,
  execute: askUserQuestion,
});
