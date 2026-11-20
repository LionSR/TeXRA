/**
 * Headless CLI side of the request protocol.
 *
 * A run asks a person with `request.opened`; the session view lists it in
 * `view.requests` until a `request.decided` answers it. This host answers
 * each request the session asks it (`SessionHost.approve`) with the prompt
 * the operator sees; the session's loop asks it once per listed request
 * and records the answer. A run with nobody to ask (a non-interactive
 * mode) attaches no handler: the session's policy denies each request as
 * it opens, and withholds the approval-gated tools. Nothing is staged
 * here: a tool edit's diff is the session's preview of it.
 */
import { Effect, Result } from 'effect';

import { withLogChannel } from '@texra-ai/harness/plugins';
import {
  type RequestDecision,
  type RequestPayload,
  type RunId,
  type UserQuestionAnswers,
  type UserQuestionRequest,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import {
  type CliApprovalContent,
  type CliApprovalPromptHooks,
  askApproval,
  queueCliApprovalQuestion,
  whilePrompting,
} from '../approval/approvalPrompts';
import {
  buildAgentProposalApprovalContent,
  buildToolEditApprovalContent,
  formatBashApprovalSummary,
  formatRetryRequestMessage,
  formatUserQuestionPrompt,
} from '../approval/approvalSummaries';
import {
  parseUserQuestionAnswer,
  userQuestionDecision,
} from './userQuestionAnswer';
import { readToolEditPreview } from '@texra/controllers/approval/ToolEditApprovalController';
import {
  declineDecision,
  REQUEST_ACTIONS,
} from '@texra/shared/session/surfaceDecision';
import { CliInvocation } from '../platform/cliContext';
import { REQUEST_ASK } from '@ui/copy/requestCards';
import { toolEditDiffLabel } from '@ui/copy/toolEditPreview';
import { CliPromptFailed, writeTextStderr } from '../platform/logSinks';
import type { Session, SessionHost, HostInteractions } from '@texra-ai/harness';

const CHANNEL = 'cli.approval';

interface HeadlessCliHostInteractionHooks extends CliApprovalPromptHooks {
  readonly emit?: HostInteractions['emit'];
}

const askHeadlessUserQuestion = Effect.fn(
  'approvalAdapter.askHeadlessUserQuestion',
)(function* (payload: UserQuestionRequest, hooks: CliApprovalPromptHooks) {
  const answers: Record<string, UserQuestionAnswers[string]> = {};
  const asked = yield* Effect.result(
    Effect.forEach(
      payload.questions,
      Effect.fnUntraced(function* (question) {
        // The two helpers parse caller content, so either can throw. Left as
        // bare calls their throw is a defect, which `Effect.result` does not
        // capture — the fallback below would be skipped and the whole
        // session would abort on what is only a rejected question.
        // `Effect.try` puts them back in the failure channel, where
        // interruption still passes through.
        const formatted = yield* Effect.try({
          try: () =>
            formatUserQuestionPrompt({
              ...payload,
              questions: [question],
            }),
          catch: CliPromptFailed.from,
        });
        const answer = yield* whilePrompting(
          hooks,
          queueCliApprovalQuestion({
            summary: payload.context
              ? `${payload.context}\n\n${formatted}`
              : formatted,
            prompt: 'Answer (blank to skip): ',
          }),
        );
        const parsed = yield* Effect.try({
          try: () => parseUserQuestionAnswer(answer, question),
          catch: CliPromptFailed.from,
        });
        if (parsed != null) answers[question.question] = parsed;
      }),
    ),
  );
  if (Result.isFailure(asked)) {
    yield* Effect.logWarning(
      `The CLI user-question prompt failed: ${toErrorMessage(asked.failure)}`,
    ).pipe(withLogChannel(CHANNEL));
    return {
      action: 'cancel',
      cause: `CLI user question prompt failed: ${toErrorMessage(asked.failure)}`,
    } satisfies RequestDecision;
  }

  return userQuestionDecision(answers);
});

/**
 * The headless run's host: its notices, and, in an interactive run, the
 * prompt that answers each request. `session` is the headless run's
 * session, threaded from the composition that opened it; a tool edit's
 * preview is read from it. The session answers requests on its own fibers,
 * so the prompt carries this invocation with it.
 */
export const createHeadlessCliHostInteractions = Effect.fnUntraced(function* (
  session: Pick<Session, 'request'>,
  hooks: HeadlessCliHostInteractionHooks = {},
): Effect.fn.Return<SessionHost, never, CliInvocation> {
  const invocation = yield* CliInvocation;
  /** The prompt content for a tool edit: the session's preview of it, else
   *  the diff's label and why there is no diff. */
  const toolEditContent = Effect.fn('approvalAdapter.toolEditContent')(
    function* (
      runId: RunId,
      payload: Extract<RequestPayload, { kind: 'toolEdit' }>,
    ) {
      const { data } = payload;
      const read = yield* readToolEditPreview(session, runId, data.requestId);
      if (read.kind === 'preview')
        return buildToolEditApprovalContent({ ...data, ...read.content });
      return {
        summary: `${toolEditDiffLabel(data).title}\nPreview unavailable: ${read.reason}`,
      } satisfies CliApprovalContent;
    },
  );

  /** One request, answered by the prompt. */
  const approve = Effect.fn('approvalAdapter.approve')(function* (
    runId: RunId,
    payload: RequestPayload,
  ): Effect.fn.Return<RequestDecision, Error, CliInvocation> {
    const ask = (content: CliApprovalContent) =>
      askApproval(payload.kind, content, hooks);
    switch (payload.kind) {
      case 'bash':
        return yield* ask({ summary: formatBashApprovalSummary(payload.data) });
      case 'toolEdit':
        return yield* ask(yield* toolEditContent(runId, payload));
      case 'planApproval':
        return yield* ask({
          summary: `${REQUEST_ASK.plan}:\n${payload.data.plan.objective}`,
        });
      case 'proposal':
        return yield* ask(buildAgentProposalApprovalContent(payload.data));
      case 'retry': {
        const summary = formatRetryRequestMessage(payload.data);
        // The summary is written under the prompt's hold, so the status
        // line it displaced cannot repaint between it and the question;
        // `askApproval` holds again inside, which nests.
        const decision = yield* whilePrompting(
          hooks,
          Effect.suspend(() => {
            writeTextStderr(summary);
            return ask({ summary });
          }),
        );
        if (decision.action === 'approve') return REQUEST_ACTIONS.retry.y;
        // A dismissed retry is the operator stopping the task, not a policy
        // refusal; the note they left goes to stderr beside it.
        const note =
          decision.action === 'reject' ? decision.feedback : decision.cause;
        writeTextStderr(note ? `${summary}\n${note}` : summary);
        return declineDecision('retry', note);
      }
      case 'userQuestion':
        return yield* askHeadlessUserQuestion(payload.data, hooks);
    }
  });

  return {
    emit: hooks.emit,
    // Only an interactive run can answer a prompt.
    ...(invocation.context.mode === 'interactive'
      ? {
          approve: (pending) =>
            approve(pending.runId, pending.payload).pipe(
              Effect.provideService(CliInvocation, invocation),
            ),
        }
      : { approvalPromptsUnavailable: true }),
  };
});
