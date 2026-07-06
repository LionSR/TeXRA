import { nanoid } from 'nanoid';
import pDefer, { type DeferredPromise } from 'p-defer';
import { z } from 'zod';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { createChannelTrace } from '@logger';
import {
  UserQuestionAnswersSchema,
  UserQuestionPromptSchema,
  type StreamTabId,
  type UserQuestionAnswers,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import { requireRuntimeHost } from '@tools/contextHelpers';
import { defineTool } from '@tools/core/define';

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

export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

interface UserQuestionResult {
  submitted: boolean;
  answers?: UserQuestionAnswers;
  feedback?: string;
}

type PendingQuestion = {
  streamId?: StreamTabId;
  runtimeHost?: AgentRuntimeHost;
  deferred: DeferredPromise<UserQuestionResult>;
};

const pendingQuestions = new Map<string, PendingQuestion>();

/** Resolve (as declined) every pending question matching `predicate`. */
function rejectPendingQuestions(
  predicate: (entry: PendingQuestion) => boolean,
): void {
  for (const entry of pendingQuestions.values()) {
    if (predicate(entry)) entry.deferred.resolve({ submitted: false });
  }
}

async function awaitUserQuestionResponse(params: {
  requestId: string;
  input: AskUserQuestionInput;
  runtimeHost: AgentRuntimeHost;
  streamId?: StreamTabId;
}): Promise<UserQuestionResult> {
  const deferred = pDefer<UserQuestionResult>();
  pendingQuestions.set(params.requestId, {
    streamId: params.streamId,
    runtimeHost: params.runtimeHost,
    deferred,
  });

  params.runtimeHost.emit('requestEnsureProgressView', {});
  if (params.streamId) {
    params.runtimeHost.emit('setActiveStream', { streamId: params.streamId });
  }
  params.runtimeHost.emit('showUserQuestion', {
    requestId: params.requestId,
    questions: params.input.questions,
    context: params.input.context ?? undefined,
    allowBypass: false,
    streamId: params.streamId ?? '',
  });

  return deferred.promise;
}

export async function handleUserQuestionAction(payload: {
  requestId: string;
  action: 'submit' | 'reject' | 'skip';
  answers?: UserQuestionAnswers;
  feedback?: string;
}): Promise<void> {
  const entry = pendingQuestions.get(payload.requestId);
  if (!entry) return;

  entry.deferred.resolve({
    submitted: payload.action === 'submit',
    answers: payload.action === 'submit' ? payload.answers : undefined,
    feedback: payload.action === 'submit' ? undefined : payload.feedback,
  });
}

/** @internal Called by unified cleanup. */
export function _rejectPendingUserQuestionsForStream(
  streamId: StreamTabId,
): void {
  rejectPendingQuestions((entry) => entry.streamId === streamId);
}

/** @internal Called by unified cleanup. */
export function _rejectAllPendingUserQuestions(): void {
  rejectPendingQuestions(() => true);
}

/** @internal Called by unified cleanup for questions with no concrete stream. */
export function _rejectUnscopedUserQuestions(
  runtimeHost?: AgentRuntimeHost,
): void {
  rejectPendingQuestions(
    (entry) =>
      !entry.streamId &&
      (runtimeHost === undefined || entry.runtimeHost === runtimeHost),
  );
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
    const requestId = `user-question-${nanoid()}`;

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
    let usedInteraction = false;
    try {
      const interaction =
        runtimeHost.interactions?.askUserQuestion?.(permission);
      usedInteraction = interaction != null;
      const result = interaction
        ? await interaction
        : await awaitUserQuestionResponse({
            requestId,
            input,
            runtimeHost,
            streamId,
          });

      if (!result.submitted) {
        return {
          status: 'executed',
          output: result.feedback
            ? `The user declined to answer: ${result.feedback}`
            : 'The user declined to answer.',
        };
      }

      const answers = UserQuestionAnswersSchema.parse(result.answers ?? {});
      if (Object.keys(answers).length === 0) {
        return {
          status: 'executed',
          output: 'The user submitted no answers.',
        };
      }

      return {
        status: 'executed',
        output: JSON.stringify({ answers }, null, 2),
        summary: `Answered ${Object.keys(answers).length} user question(s).`,
      };
    } finally {
      pendingQuestions.delete(requestId);
      if (!usedInteraction) {
        runtimeHost.emit('resolveUserQuestion', { requestId });
      }
    }
  }
}
