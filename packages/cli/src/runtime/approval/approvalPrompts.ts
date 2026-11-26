import { Effect } from 'effect';

import { withLogChannel } from '@texra-ai/worldline/plugins';
import {
  type RequestDecision,
  type RequestPayload,
  toErrorMessage,
} from '@texra-ai/worldline/schemas';
import {
  REJECTION_NOTE_PROMPT,
  requestPrimaryLabel,
} from '@ui/copy/requestCards';

import { CliInvocation } from '../platform/cliContext';
import {
  askCliQuestion,
  CliPromptFailed,
  writeTextStderr,
} from '../platform/logSinks';
import { safeTerminalText } from '../terminal/terminalText';

const CHANNEL = 'cli.approval';

/** Called as a prompt opens, before anything is written for it; what it
 *  returns is called once the prompt is answered. The headless renderer
 *  holds its live status line off the terminal in between. */
export type PromptHold = () => (() => void) | undefined;

/**
 * Run `ask` as the one prompt open under `hold`: the hold is taken first
 * and released however `ask` ends. It prepares the terminal, so it can
 * throw; `Effect.try` puts that in the failure channel, where the caller's
 * `Effect.catch` handles it, instead of a defect that would abort the tool
 * and the session.
 */
export const whilePrompting = <A, E, R>(
  hold: PromptHold,
  ask: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CliPromptFailed, R> =>
  Effect.acquireUseRelease(
    Effect.try({ try: hold, catch: CliPromptFailed.from }),
    () => ask,
    (release) => Effect.sync(() => release?.()),
  );

export interface CliApprovalContent {
  readonly summary: string;
  /** Complete content behind a bounded summary, shown only on request. */
  readonly details?: () => string;
}

interface CliPromptRequest {
  readonly summary: string;
  readonly prompt: string;
}

const askCliApprovalQuestion = (request: CliPromptRequest) =>
  askCliQuestion(
    request.summary ? `${request.summary}\n${request.prompt}` : request.prompt,
  );

type PromptDecision = Extract<
  RequestDecision,
  { action: 'approve' | 'reject' }
>;

/** What a typed answer decides, or that a bare "no" is asked for a note. */
function parseApprovalAnswer(answer: string): PromptDecision | 'askFeedback' {
  const trimmed = answer.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === 'y' || normalized === 'yes') return { action: 'approve' };
  if (normalized === '') return { action: 'reject' };

  const rejectMatch = /^(?:n|no)(?:\s+(.+))?$/i.exec(trimmed);
  if (rejectMatch === null) return { action: 'reject', feedback: trimmed };
  const feedback = rejectMatch[1]?.trim();
  return feedback ? { action: 'reject', feedback } : 'askFeedback';
}

function isViewDetailsAnswer(answer: string): boolean {
  return /^v(?:iew)?$/i.test(answer.trim());
}

/**
 * Run a CLI prompt on the invocation's serial prompt lane. Exposed so the
 * user-question handler can interleave its own per-question prompts with
 * approval prompts without overlapping reads from a single stdin.
 */
export const queueCliApprovalQuestion = (request: CliPromptRequest) =>
  CliInvocation.use(({ onPromptLane }) =>
    onPromptLane(askCliApprovalQuestion(request)),
  );

/** Ask about one `kind` request, in its primary action's word (`Approve?`,
 *  `Retry?`), as every host's card names it. */
export const askApproval = Effect.fn('approvalPrompts.askApproval')(function* (
  kind: RequestPayload['kind'],
  content: CliApprovalContent,
  hold: PromptHold,
) {
  const { onPromptLane } = yield* CliInvocation;
  return yield* onPromptLane(
    Effect.gen(function* () {
      const prompt = `${requestPrimaryLabel(kind)}? ${
        content.details
          ? '[y/N, v view full, or n <feedback>] '
          : '[y/N, or n <feedback>] '
      }`;
      const answer = yield* whilePrompting(
        hold,
        askCliApprovalQuestion({ summary: content.summary, prompt }),
      ).pipe(
        Effect.repeat({
          while: (answer) => {
            const details = content.details;
            if (details == null || !isViewDetailsAnswer(answer)) return false;
            // A rendering error closes the request through the prompt's
            // failure handler.
            return Effect.try({
              try: () => writeTextStderr(safeTerminalText(details())),
              catch: CliPromptFailed.from,
            }).pipe(Effect.as(true));
          },
        }),
      );

      const parsed = parseApprovalAnswer(answer);
      if (parsed !== 'askFeedback') return parsed;
      const feedback = (yield* whilePrompting(
        hold,
        askCliApprovalQuestion({
          summary: '',
          prompt: `${REJECTION_NOTE_PROMPT} (optional, Enter to skip) `,
        }),
      )).trim();
      const rejected: PromptDecision = {
        action: 'reject',
        ...(feedback && { feedback }),
      };
      return rejected;
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
