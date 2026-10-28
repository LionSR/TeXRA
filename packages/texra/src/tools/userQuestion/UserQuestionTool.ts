import { Effect, Schema } from 'effect';

import { defineTool } from '@texra-ai/harness';
import { withLogChannel } from '@texra-ai/harness/host';
import { requireRun, executed, refusalOf } from '@texra-ai/harness/plugins';
import {
  UserQuestionAnswersSchema,
  UserQuestionPromptSchema,
  type UserQuestionPermission,
} from '@texra-ai/harness/schemas';

const CHANNEL = 'UserQuestionTool';

/** `"<base>: <detail>"` when a detail exists, else `"<base>."` */
function withDetail(base: string, detail: string | undefined): string {
  return detail ? `${base}: ${detail}` : `${base}.`;
}

const AskUserQuestionInputSchema = Schema.Struct({
  questions: Schema.Array(UserQuestionPromptSchema)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(3))
    .annotate({
      description:
        'One to three questions for the user. Keep each question short and provide two to four clear options.',
    }),
  context: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: 'Optional short context explaining why the answer is needed.',
  }),
});

type AskUserQuestionInput = typeof AskUserQuestionInputSchema.Type;

const askUserQuestion = Effect.fn('AskUserQuestionTool.execute')(function* (
  input: AskUserQuestionInput,
) {
  const {
    run: { runId },
    requests,
  } = yield* requireRun('ask_user_question');
  const requestId = requests.nextId('userQuestion');

  yield* Effect.logInfo('User question requested').pipe(
    Effect.annotateLogs({
      data: input.questions[0]?.question.slice(0, 100) ?? '',
    }),
    withLogChannel(CHANNEL),
  );

  const permission: UserQuestionPermission = {
    requestId,
    questions: input.questions,
    context: input.context ?? undefined,
    allowBypass: false,
    runId,
  };
  const decision = yield* requests.open({
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

  const answers = Schema.decodeUnknownSync(UserQuestionAnswersSchema)(
    decision.answers,
  );
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
  requiresApproval: 'inBody',
  description: `Ask the user one to three short clarification questions and wait for their answers.

Use this when the task has several reasonable paths and continuing without the user's preference would be guesswork. Provide two to four concrete options for each question. Use allowFreeText only when the listed options may not cover the user's answer.

The tool returns a JSON object whose keys are the original question texts and whose values are the selected option labels, arrays of labels for multi-select questions, or free-text answers.`,
  schema: AskUserQuestionInputSchema,
  execute: askUserQuestion,
});
