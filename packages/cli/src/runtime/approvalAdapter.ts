/**
 * Headless CLI side of the request protocol (one run model, 3.7).
 *
 * A run asks a person with `request.opened`; the fold lists it in
 * `view.requests` until a `request.decided` answers it. This host watches
 * that list and answers each request from the terminal — the policy's own
 * decision when there is nobody to ask, otherwise the prompt the operator
 * sees — and stages nothing else: the port it attaches presents events,
 * mirrors bypass state, and holds a tool edit's preview so the diff can be
 * printed.
 */
import { Effect, Exit, Fiber, Result, Stream, SubscriptionRef } from 'effect';

import {
  defaultSession,
  type HostApprovalBypassStateUpdate,
  type HostInteractions,
} from '@agent/runtime';
import { warn as logWarning } from '@logger/logUtils';
import { effectRuntime } from '@platform/processRuntime';
import { requestParksItsCaller } from '@shared/schemas';
import type {
  PermissionPayload,
  RequestDecision,
  RunId,
  UserQuestionAnswers,
  UserQuestionPermission,
} from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import { type ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  settleExecutable,
  settleHumanInputDenial,
  settleRetry,
} from './approval/settleApprovals';
import {
  type CliApprovalContent,
  type CliApprovalPromptHooks,
  askApproval,
  queueCliApprovalQuestion,
} from './approval/approvalPrompts';
import {
  buildAgentProposalApprovalContent,
  buildToolEditApprovalContent,
  formatBashApprovalSummary,
  formatRetryRequestMessage,
  formatUserQuestionPrompt,
} from './approval/approvalSummaries';
import {
  parseUserQuestionAnswer,
  USER_QUESTION_SKIPPED_FEEDBACK,
} from './userQuestionAnswer';
import { type CliContext } from './cliContext';
import { writeTextStderr } from './logSinks';

interface HeadlessCliHostInteractionHooks extends CliApprovalPromptHooks {
  readonly emit?: HostInteractions['emit'];
  readonly setApprovalBypassState?: (
    update: HostApprovalBypassStateUpdate,
  ) => void;
}

/**
 * The kinds this host answers: every request that parks the tool which
 * opened it. An external inquiry parks nothing — the inquiry tool is
 * unavailable on the CLI, so one listed in the fold was opened by another
 * host in a shared session and is answered from its own thread. Deciding it
 * here because a headless CLI happened to observe the session would drop
 * that thread, so {@link createHeadlessCliHostInteractions} filters the kind
 * out on the same predicate the TUI queue and both folds read.
 */
type AnswerablePayload = Exclude<
  PermissionPayload,
  { kind: 'externalInquiry' }
>;

/** A pending request under {@link AnswerablePayload}. */
type AnswerableRequest = SessionView['requests'][number] & {
  readonly payload: AnswerablePayload;
};

const askHeadlessUserQuestion = Effect.fn(
  'approvalAdapter.askHeadlessUserQuestion',
)(function* (
  payload: UserQuestionPermission,
  context: CliContext,
  hooks: CliApprovalPromptHooks,
) {
  const answers: UserQuestionAnswers = {};
  const asked = yield* Effect.result(
    Effect.forEach(payload.questions, (question) =>
      Effect.gen(function* () {
        // The hook prepares the terminal and the two helpers parse caller
        // content, so any of the three can throw. Left as bare calls their
        // throw is a defect, which `Effect.result` does not capture — the
        // fallback below would be skipped and the whole session would abort
        // on what used to settle as a rejection. `Effect.try` puts them back
        // in the failure channel, where interruption still passes through.
        const formatted = yield* Effect.try({
          try: () => {
            hooks.beforePrompt?.();
            return formatUserQuestionPrompt({
              ...payload,
              questions: [question],
            });
          },
          catch: (cause) => cause,
        });
        const answer = yield* queueCliApprovalQuestion(context, {
          kind: 'approval',
          summary: payload.context
            ? `${payload.context}\n\n${formatted}`
            : formatted,
          prompt: 'Answer (blank to skip): ',
        });
        const parsed = yield* Effect.try({
          try: () => parseUserQuestionAnswer(answer, question),
          catch: (cause) => cause,
        });
        if (parsed != null) answers[question.question] = parsed;
      }),
    ),
  );
  if (Result.isFailure(asked)) {
    logWarning(
      'cli.approval',
      `The CLI user-question prompt failed: ${toErrorMessage(asked.failure)}`,
    );
    return {
      action: 'cancel',
      cause: 'CLI user question prompt failed.',
    } satisfies RequestDecision;
  }

  if (Object.keys(answers).length === 0) {
    return {
      action: 'skip',
      feedback: USER_QUESTION_SKIPPED_FEEDBACK,
    } satisfies RequestDecision;
  }
  return { action: 'submit', answers } satisfies RequestDecision;
});

export function createHeadlessCliHostInteractions(
  context: CliContext,
  hooks: HeadlessCliHostInteractionHooks = {},
): HostInteractions {
  // Headless composition seeds the session before attaching; tests often attach
  // without that step, so mirror the seed here. TUI uses a different adapter
  // and keeps the live session value from `/approval`.
  const session = defaultSession();
  session.setApprovalPolicy(context.approvalPolicy);
  /** Requests this host has taken on, pruned as the fold drops them. */
  const acted = new Set<string>();
  /** The preview a tool edit's durable payload cannot carry. */
  const previews = new Map<string, ToolEditApprovalRequest>();

  /** Write one decision, and say whether it landed: a refused write leaves
   *  the request listed and unanswered, so reporting the refusal as a
   *  settlement would park the run on a request this host never takes
   *  again. */
  const decide = (
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
  ): Effect.Effect<boolean> =>
    session.requests
      .request({ kind: 'request.decide', runId, requestId, decision })
      .pipe(
        Effect.match({
          onFailure: (error) => {
            logWarning(
              'cli.approval',
              `The ${decision.action} decision for request ${requestId} was refused: ${toErrorMessage(error)}`,
            );
            return false;
          },
          onSuccess: () => true,
        }),
      );

  /** The prompt content for a tool edit: the staged preview when the tool
   *  boundary reached this host, else the payload's own summary. */
  const toolEditContent = (
    payload: Extract<PermissionPayload, { kind: 'toolEdit' }>,
  ): CliApprovalContent => {
    const preview = previews.get(payload.data.requestId);
    if (preview) return buildToolEditApprovalContent(preview);
    logWarning(
      'cli.approval',
      `No preview was staged for tool edit ${payload.data.requestId}: prompting without the diff.`,
    );
    const { data } = payload;
    return {
      summary: `Tool edit requested by ${data.sourceTool}: ${data.relativePath} (+${data.addedLines} / -${data.removedLines})`,
    };
  };

  /** One pending request, answered: policy first, then the prompt. Returns
   *  whether the decision reached the ledger. */
  const answer = Effect.fn('approvalAdapter.answer')(function* (
    runId: RunId,
    payload: AnswerablePayload,
  ) {
    const requestId = payload.data.requestId;
    const ask = (content: CliApprovalContent) =>
      askApproval(context, content, hooks);
    switch (payload.kind) {
      case 'bash':
        return yield* decide(
          runId,
          requestId,
          yield* ask({ summary: formatBashApprovalSummary(payload.data) }),
        );
      case 'toolEdit':
        return yield* decide(
          runId,
          requestId,
          yield* ask(toolEditContent(payload)),
        );
      case 'planApproval': {
        const settled = settleExecutable(context, runId);
        return yield* decide(
          runId,
          requestId,
          settled ??
            (yield* ask({
              summary: `Plan approval requested:\n${JSON.stringify(payload.data.plan, null, 2)}`,
            })),
        );
      }
      case 'proposal': {
        const settled = settleExecutable(context, runId);
        return yield* decide(
          runId,
          requestId,
          settled ??
            (yield* ask(buildAgentProposalApprovalContent(payload.data))),
        );
      }
      case 'retry': {
        const settled = settleRetry(payload.data, context);
        if (settled) return yield* decide(runId, requestId, settled);
        // The pre-prompt hook fires here and again inside `askApproval`; that
        // double call is pre-existing retry behavior, not a bug to "fix".
        hooks.beforePrompt?.();
        // The prompt surface owns the retry hint: the operator must see the
        // `/api personal` / coding-plan switch guidance in the prompt they
        // actually answer, not only in the pre-prompt stderr line.
        // `formatRetryRequestMessage` is the single retry formatter.
        const summary = formatRetryRequestMessage(payload.data);
        writeTextStderr(summary);
        const decision = yield* ask({ summary });
        if (decision.action === 'approve') {
          return yield* decide(runId, requestId, { action: 'retry' });
        }
        // A dismissed retry is the operator cancelling this call, not a
        // policy refusal; the note they left goes to stderr beside it.
        const note =
          decision.action === 'reject' ? decision.feedback : decision.cause;
        writeTextStderr(note ? `${summary}\n${note}` : summary);
        return yield* decide(runId, requestId, {
          action: 'cancel',
          cause: note ?? null,
        });
      }
      case 'userQuestion': {
        const denial = settleHumanInputDenial(context, runId);
        return yield* decide(
          runId,
          requestId,
          denial
            ? { action: 'deny', reason: denial.reason }
            : yield* askHeadlessUserQuestion(payload.data, context, hooks),
        );
      }
    }
  });

  const take = (view: SessionView) =>
    Effect.forEach(
      view.requests.filter(
        (pending): pending is AnswerableRequest =>
          requestParksItsCaller(pending.payload) &&
          !acted.has(pending.requestId),
      ),
      (pending) => {
        acted.add(pending.requestId);
        // Forked so one prompt does not hold the fold's tail: the context's
        // prompt lane still serializes the reads from stdin.
        return Effect.forkChild(
          answer(pending.runId, pending.payload).pipe(
            // A refused write answered nobody, and a prompt that died or was
            // interrupted never wrote at all: release the claim on every
            // exit but a landed decision, so the next view update prompts
            // for the request again instead of filtering it out for the life
            // of the process.
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(exit) && exit.value) return;
                acted.delete(pending.requestId);
              }),
            ),
          ),
        );
      },
      { discard: true },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // A preview is staged before its `request.opened` commits, so only
          // a request this host has already seen listed counts as settled.
          const live = new Set(view.requests.map((r) => r.requestId));
          for (const id of acted) {
            if (live.has(id)) continue;
            acted.delete(id);
            previews.delete(id);
          }
        }),
      ),
    );

  const fiber = effectRuntime().runFork(
    Stream.runForEach(SubscriptionRef.changes(session.view), take),
  );

  return {
    emit: hooks.emit,
    setApprovalBypassState: hooks.setApprovalBypassState,
    presentToolEdit(request) {
      previews.set(request.permission.requestId, request);
    },
    dispose() {
      effectRuntime().runFork(Fiber.interrupt(fiber));
    },
  };
}
