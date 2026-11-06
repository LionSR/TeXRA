import { Effect } from 'effect';

import {
  withLogChannel,
  type PerKeyLane,
  withPerKeyLane,
} from '@texra-ai/harness/host';
import {
  type RequestDecision,
  ensureError,
  toErrorMessage,
} from '@texra-ai/harness/schemas';

import { type CliContext, type CliPromptRequest } from '../cliContext';
import { askCliQuestion, writeTextStderr } from '../logSinks';
import { safeTerminalText } from '../terminalText';

const CHANNEL = 'cli.approval';

export interface CliApprovalPromptHooks {
  /** Called as a prompt opens, before anything is written for it; what it
   *  returns is called once the prompt is answered. The headless renderer
   *  holds its live status line off the terminal in between. */
  readonly prompting?: () => (() => void) | undefined;
}

/**
 * Run `ask` as the one prompt open under `hooks`: the hook's hold is taken
 * first and released however `ask` ends. The hook prepares the terminal, so
 * it can throw; `Effect.try` puts that in the failure channel, where the
 * caller's `Effect.catch` handles it, instead of a defect that would abort
 * the tool and the session.
 */
export const whilePrompting = <A, E, R>(
  hooks: CliApprovalPromptHooks,
  ask: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> =>
  Effect.acquireUseRelease(
    Effect.try({ try: () => hooks.prompting?.(), catch: ensureError }),
    () => ask,
    (release) => Effect.sync(() => release?.()),
  );

export interface CliApprovalContent {
  readonly summary: string;
  /** Complete content behind a bounded summary, shown only on request. */
  readonly details?: () => string;
}

/**
 * One prompt lane per CLI context: a single stdin, so two prompts never read
 * from it at once. Keyed weakly by the context, whose lifetime bounds it.
 */
const cliPromptLanes = new WeakMap<CliContext, PerKeyLane>();
function onCliPromptLane(context: CliContext) {
  return withPerKeyLane(cliPromptLanes, context);
}

const askCliApprovalQuestion = Effect.fn(
  'approvalPrompts.askCliApprovalQuestion',
)(function* (context: CliContext, request: CliPromptRequest) {
  const injected = context.approvalPrompt;
  return injected
    ? yield* injected(request)
    : yield* askCliQuestion(
        request.summary
          ? `${request.summary}\n${request.prompt}`
          : request.prompt,
      );
});

interface ParsedApprovalAnswer {
  readonly accepted: boolean;
  readonly feedback?: string;
  readonly shouldPromptForFeedback: boolean;
}

function parseApprovalAnswer(answer: string): ParsedApprovalAnswer {
  const trimmed = answer.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === 'y' || normalized === 'yes') {
    return { accepted: true, shouldPromptForFeedback: false };
  }

  if (normalized === '') {
    return { accepted: false, shouldPromptForFeedback: false };
  }

  const rejectMatch = /^(?:n|no)(?:\s+(.+))?$/i.exec(trimmed);
  if (rejectMatch) {
    const feedback = rejectMatch[1]?.trim();
    return {
      accepted: false,
      ...(feedback ? { feedback } : {}),
      shouldPromptForFeedback: feedback == null,
    };
  }

  return {
    accepted: false,
    feedback: trimmed,
    shouldPromptForFeedback: false,
  };
}

function isViewDetailsAnswer(answer: string): boolean {
  return /^v(?:iew)?$/i.test(answer.trim());
}

/**
 * Run a CLI prompt on the context's serial prompt lane. Exposed so the
 * user-question handler can interleave its own per-question prompts with
 * approval prompts without overlapping reads from a single stdin.
 */
export function queueCliApprovalQuestion(
  context: CliContext,
  request: CliPromptRequest,
) {
  return onCliPromptLane(context)(askCliApprovalQuestion(context, request));
}

export const askApproval = Effect.fn('approvalPrompts.askApproval')(function* (
  context: CliContext,
  content: CliApprovalContent,
  hooks: CliApprovalPromptHooks = {},
) {
  return yield* onCliPromptLane(context)(
    Effect.gen(function* () {
      const prompt = content.details
        ? 'Approve? [y/N, v view full, or n <feedback>] '
        : 'Approve? [y/N, or n <feedback>] ';
      let answer: string;
      // `content.details()` renders caller-supplied content, so it can
      // throw. Left as a bare call inside the gen its throw is a defect,
      // which the `Effect.catch` below does not see: the rejection decision
      // it finishes would be skipped and `runPromise` would abort the tool
      // and the session, where the outer try/catch this replaced handled it.
      // `Effect.try` puts it back in the failure channel, and unlike catching
      // the whole cause it leaves interruption free to propagate.
      while (true) {
        answer = yield* whilePrompting(
          hooks,
          askCliApprovalQuestion(context, {
            summary: content.summary,
            prompt,
          }),
        );
        const details = content.details;
        if (details == null || !isViewDetailsAnswer(answer)) {
          break;
        }
        yield* Effect.try({
          try: () => writeTextStderr(safeTerminalText(details())),
          catch: ensureError,
        });
      }

      const parsed = parseApprovalAnswer(answer);
      let feedback = parsed.feedback;
      if (!parsed.accepted && parsed.shouldPromptForFeedback) {
        const feedbackAnswer = yield* whilePrompting(
          hooks,
          askCliApprovalQuestion(context, {
            summary: '',
            prompt: 'Rejection feedback (optional, Enter to skip): ',
          }),
        );
        feedback = feedbackAnswer.trim() || undefined;
      }

      const decision: RequestDecision = parsed.accepted
        ? { action: 'approve' }
        : { action: 'reject', feedback: feedback ?? null };
      return decision;
    }),
  ).pipe(
    Effect.catch((error) => {
      // A prompt that never reached a person closes the request rather
      // than speaking for one: the cause says so.
      const failed: RequestDecision = {
        action: 'cancel',
        cause: `CLI approval prompt failed: ${toErrorMessage(error)}`,
      };
      return Effect.logWarning(
        `The CLI approval prompt failed: ${toErrorMessage(error)}`,
      ).pipe(withLogChannel(CHANNEL), Effect.as(failed));
    }),
  );
});
