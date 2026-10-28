/**
 * Headless CLI side of the request protocol (one run model, 3.7).
 *
 * A run asks a person with `request.opened`; the fold lists it in
 * `view.requests` until a `request.decided` answers it. This host watches
 * that list and answers each request with the prompt the operator sees. The
 * session already settled what its approval policy decides, so what is listed
 * needs a person, or a denial on a run with nobody to ask. Nothing else is
 * staged: the port it attaches presents events, mirrors bypass state, and
 * holds a tool edit's preview so the diff can be printed.
 */
import { Effect, Exit, Result, Stream } from 'effect';

import {
  withLogChannel,
  type HostInteractions,
  type ToolEditApprovalRequest,
} from '@texra-ai/harness/host';
import {
  type RequestDecision,
  approvalPolicyDenialMessage,
  requestParksItsCaller,
  type PermissionPayload,
  type RunId,
  type UserQuestionAnswers,
  type UserQuestionPermission,
  ensureError,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import {
  type CliApprovalContent,
  type CliApprovalPromptHooks,
  askApproval,
  queueCliApprovalQuestion,
  warnApprovalDenied,
  whilePrompting,
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
  userQuestionDecision,
} from './userQuestionAnswer';
import { type CliContext } from './cliContext';
import { writeTextStderr } from './logSinks';
import type { Session } from '@texra-ai/harness';
import type { SessionView } from '@texra-ai/harness/schemas';

const CHANNEL = 'cli.approval';

interface HeadlessCliHostInteractionHooks extends CliApprovalPromptHooks {
  readonly emit?: HostInteractions['emit'];
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
  const answers: Record<string, UserQuestionAnswers[string]> = {};
  const asked = yield* Effect.result(
    Effect.forEach(payload.questions, (question) =>
      Effect.gen(function* () {
        // The two helpers parse caller content, so either can throw. Left as
        // bare calls their throw is a defect, which `Effect.result` does not
        // capture — the fallback below would be skipped and the whole
        // session would abort on what used to settle as a rejection.
        // `Effect.try` puts them back in the failure channel, where
        // interruption still passes through.
        const formatted = yield* Effect.try({
          try: () =>
            formatUserQuestionPrompt({
              ...payload,
              questions: [question],
            }),
          catch: ensureError,
        });
        const answer = yield* whilePrompting(
          hooks,
          queueCliApprovalQuestion(context, {
            summary: payload.context
              ? `${payload.context}\n\n${formatted}`
              : formatted,
            prompt: 'Answer (blank to skip): ',
          }),
        );
        const parsed = yield* Effect.try({
          try: () => parseUserQuestionAnswer(answer, question),
          catch: ensureError,
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

/** The view subscription below is forked into the caller's scope, which
 *  interrupts it on close. `session` is the headless run's session, threaded
 *  from the composition that opened it. */
export function createHeadlessCliHostInteractions(
  session: Pick<Session, 'request' | 'view'>,
  context: CliContext,
  hooks: HeadlessCliHostInteractionHooks = {},
) {
  /** Only an interactive run can answer a prompt. */
  const promptsUnavailable = context.mode !== 'interactive';
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
    session
      .request({ kind: 'request.decide', runId, requestId, decision })
      .pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.logWarning(
              `The ${decision.action} decision for request ${requestId} was refused: ${toErrorMessage(error)}`,
            ).pipe(withLogChannel(CHANNEL), Effect.as(false)),
          onSuccess: () => Effect.succeed(true),
        }),
      );

  /** The prompt content for a tool edit: the staged preview when the tool
   *  boundary reached this host, else the payload's own summary. */
  const toolEditContent = Effect.fn('approvalAdapter.toolEditContent')(
    function* (payload: Extract<PermissionPayload, { kind: 'toolEdit' }>) {
      const preview = previews.get(payload.data.requestId);
      if (preview) return buildToolEditApprovalContent(preview);
      yield* Effect.logWarning(
        `No preview was staged for tool edit ${payload.data.requestId}: prompting without the diff.`,
      ).pipe(withLogChannel(CHANNEL));
      const { data } = payload;
      return {
        summary: `Tool edit requested by ${data.sourceTool}: ${data.relativePath} (+${data.addedLines} / -${data.removedLines})`,
      } satisfies CliApprovalContent;
    },
  );

  /** One pending request, answered: denied when this run has nobody to ask
   *  (a request opened before the host or policy changed is listed pending,
   *  and a prompt on a closed stdin never settles), else by the prompt.
   *  Returns whether the decision reached the run history. */
  const answer = Effect.fn('approvalAdapter.answer')(function* (
    runId: RunId,
    payload: AnswerablePayload,
  ) {
    const requestId = payload.data.requestId;
    if (promptsUnavailable) {
      return yield* decide(runId, requestId, {
        action: 'deny',
        reason: approvalPolicyDenialMessage('deny-unpresentable'),
      });
    }
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
          yield* ask(yield* toolEditContent(payload)),
        );
      case 'planApproval':
        return yield* decide(
          runId,
          requestId,
          yield* ask({
            summary: `Plan approval requested:\n${JSON.stringify(payload.data.plan, null, 2)}`,
          }),
        );
      case 'proposal':
        return yield* decide(
          runId,
          requestId,
          yield* ask(buildAgentProposalApprovalContent(payload.data)),
        );
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
      case 'userQuestion':
        return yield* decide(
          runId,
          requestId,
          yield* askHeadlessUserQuestion(payload.data, context, hooks),
        );
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

  const host: HostInteractions = {
    emit: hooks.emit,
    approvalPromptsUnavailable: promptsUnavailable,
    approvalDenied: (denial, runId) =>
      warnApprovalDenied(context, denial, runId),
    presentToolEdit(request) {
      previews.set(request.permission.requestId, request);
    },
    // The prune above only reaches a request the fold has listed, so a
    // request whose `request.opened` never committed would keep its preview
    // for the life of the process. This is that release, the program the
    // session runs for that one case.
    releaseToolEdit: (requestId) =>
      Effect.sync(() => {
        previews.delete(requestId);
      }),
  };
  return Effect.as(
    Effect.forkScoped(Stream.runForEach(session.view.changes, take)),
    host,
  );
}
