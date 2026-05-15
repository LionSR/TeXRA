import { z } from 'zod';

import { tryUseRunContext } from '@agent/runtime/RunContext';
import { AgentLogger } from '@logger/AgentLogger';
import {
  UserQuestionAnswersSchema,
  UserQuestionPromptSchema,
  type StreamTabId,
  type UserQuestionAnswers,
} from '@shared/schemas';
import type { ToolResult } from '@tools/result';
import { requireRuntimeHost } from '@tools/contextHelpers';
import { defineTool } from '@tools/core/define';

const logger = new AgentLogger('UserQuestionTool');

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

export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

interface UserQuestionResult {
  submitted: boolean;
  answers?: UserQuestionAnswers;
  feedback?: string;
}

let questionCounter = 0;
const pendingQuestions = new Map<
  string,
  {
    streamId?: StreamTabId;
    settle: (result: UserQuestionResult) => void;
    isSettled: () => boolean;
  }
>();

async function awaitUserQuestionResponse(params: {
  requestId: string;
  input: AskUserQuestionInput;
  streamId?: StreamTabId;
}): Promise<UserQuestionResult> {
  const runtimeHost = requireRuntimeHost(
    'ask_user_question',
    tryUseRunContext(),
  );
  return new Promise<UserQuestionResult>((resolve) => {
    let settled = false;
    const settle = (result: UserQuestionResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    pendingQuestions.set(params.requestId, {
      streamId: params.streamId,
      settle,
      isSettled: () => settled,
    });

    runtimeHost.emit('requestEnsureProgressView', {});
    if (params.streamId) {
      runtimeHost.emit('setActiveStream', { streamId: params.streamId });
    }
    runtimeHost.emit('showUserQuestion', {
      requestId: params.requestId,
      questions: params.input.questions,
      context: params.input.context ?? undefined,
      allowBypass: false,
      streamId: params.streamId ?? '',
    });
  });
}

export async function handleUserQuestionAction(payload: {
  requestId: string;
  action: 'submit' | 'reject' | 'skip';
  answers?: UserQuestionAnswers;
  feedback?: string;
}): Promise<void> {
  const entry = pendingQuestions.get(payload.requestId);
  if (!entry || entry.isSettled()) return;

  entry.settle({
    submitted: payload.action === 'submit',
    answers: payload.action === 'submit' ? payload.answers : undefined,
    feedback: payload.action === 'submit' ? undefined : payload.feedback,
  });
}

/** @internal Called by unified cleanup. */
export function _rejectPendingUserQuestionsForStream(
  streamId: StreamTabId,
): void {
  for (const entry of pendingQuestions.values()) {
    if (entry.streamId === streamId && !entry.isSettled()) {
      entry.settle({ submitted: false });
    }
  }
}

/** @internal Called by unified cleanup. */
export function _rejectAllPendingUserQuestions(): void {
  for (const entry of pendingQuestions.values()) {
    if (!entry.isSettled()) {
      entry.settle({ submitted: false });
    }
  }
}

export class AskUserQuestionTool extends defineTool({
  name: 'ask_user_question',
  description: `Ask the user one to three short clarification questions and wait for their answers.

Use this when the task has several reasonable paths and continuing without the user's preference would be guesswork. Provide two to four concrete options for each question. Use allowFreeText only when the listed options may not cover the user's answer.

The tool returns a JSON object whose keys are the original question texts and whose values are the selected option labels, arrays of labels for multi-select questions, or free-text answers.`,
  schema: AskUserQuestionInputSchema,
}) {
  protected async execute(input: AskUserQuestionInput): Promise<ToolResult> {
    const context = tryUseRunContext();
    const runtimeHost = requireRuntimeHost('ask_user_question', context);
    const streamId = context?.streamId;
    const requestId = `user-question-${Date.now().toString(36)}-${++questionCounter}`;

    logger.info(
      `User question requested: ${input.questions[0]?.question.substring(0, 100) ?? ''}`,
    );

    try {
      const result = await awaitUserQuestionResponse({
        requestId,
        input,
        streamId,
      });

      if (!result.submitted) {
        return {
          output: result.feedback
            ? `The user declined to answer: ${result.feedback}`
            : 'The user declined to answer.',
        };
      }

      const answers = UserQuestionAnswersSchema.parse(result.answers ?? {});
      if (Object.keys(answers).length === 0) {
        return {
          output: 'The user submitted no answers.',
        };
      }

      return {
        output: JSON.stringify({ answers }, null, 2),
        summary: `Answered ${Object.keys(answers).length} user question(s).`,
      };
    } finally {
      pendingQuestions.delete(requestId);
      runtimeHost.emit('resolveUserQuestion', { requestId });
    }
  }
}
