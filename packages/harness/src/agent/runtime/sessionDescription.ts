/**
 * Session description generation.
 *
 * When a run starts, or resumes without one, generates a short AI summary
 * describing what it aims to accomplish, published as the run's
 * `run.description` row so the stream tab, history view, and future agents
 * can quickly understand each session.
 */

import { Cause, Context, Effect, Exit, Fiber } from 'effect';

import { helperCall } from '@agent/runtime/helperModel';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { withLogChannel } from '@logger/effectLog';
import { SessionRoots } from '@platform/rootedFs';
import type { Secrets } from '@platform/secrets';
import {
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
  type AgentConfig,
} from '@shared/schemas';
import { SessionLog } from '@shared/session/runHistory';
import type { UsageLog } from '@shared/usageLog';
import { descriptionRow } from '@shared/session/runFacts';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import type { RouteRetries } from './ModelRetryGate';
import type { HttpClient } from 'effect/http';

const CHANNEL = 'SessionDescription';
const MAX_DESCRIPTION_LENGTH = 80;
const MAX_DESCRIPTION_WORDS = 12;

/**
 * Normalize a model-generated session description: collapse newlines,
 * strip surrounding quotes/backticks, drop trailing sentence punctuation,
 * and truncate to a UI-friendly length. Returns an empty string when the
 * cleaned result has no meaningful content.
 */
function cleanSessionDescription(text: string): string {
  const cleaned = text
    .trim()
    .replaceAll(/\s*\n\s*/g, ' ')
    .replaceAll(/^["'`]+|["'`]+$/g, '')
    .replaceAll(/[.!?…]+$/g, '')
    .trim();
  if (!cleaned) return '';
  if (cleaned.split(/\s+/).length > MAX_DESCRIPTION_WORDS) return '';
  return truncateWithEllipsis(cleaned, MAX_DESCRIPTION_LENGTH);
}

const SYSTEM_PROMPT = `Generate a short session label from the agent name, description, and user's instruction. Use at most 10 words and no trailing period. Be specific but terse. Use no full sentences, meta-commentary, or quotes. Use present-tense verb phrases (e.g. "Reviewing introduction for clarity", "Fixing TikZ arrow alignment").`;

/**
 * Build a user prompt for session description generation.
 */
function buildUserPrompt(
  agentName: string,
  agentDescription: string | undefined,
  instruction: string,
): string {
  const parts = [`<agent>${agentName}</agent>`];
  if (agentDescription) {
    parts.push(`<agent-purpose>${agentDescription}</agent-purpose>`);
  }
  parts.push(`<instruction>${instruction}</instruction>`);
  return parts.join('\n');
}

/**
 * The instruction text shown to the user for a run: the display override when
 * it carries content, otherwise the real instruction. Single owner of that
 * derivation for both the stream-tab user message and the session description,
 * so a blank display override can never surface as a blank label on one
 * surface and the instruction on the other.
 */
export function getDisplayedInstruction(
  config: Pick<AgentConfig, 'displayInstruction' | 'instruction'>,
): string {
  return config.displayInstruction?.trim() || config.instruction.trim();
}

/**
 * Whether the session labels its root runs: one extra helper-model request
 * per root run, counted in the run's usage through its `run.description`.
 * The label is the app's (a session's title in its run list and history),
 * so it is off unless the process layer provides it (`processLayer`
 * does; `Sessions.layer` does not); a child
 * run is never labelled and keeps its agent name.
 */
export const RunLabels = Context.Reference<boolean>(
  '@texra-ai/harness/agent/RunLabels',
  { defaultValue: () => false },
);

/** How long a run's end may wait on its optional description. */
const DESCRIPTION_DEADLINE = '20 seconds';

/**
 * Generate and persist a session description from the user's instruction.
 *
 * Started concurrently at the beginning of a run and joined before run
 * ownership is released. Never fails: an unavailable or failing helper is
 * warned about and the run keeps its agent-name label. Stopping the run
 * interrupts it.
 *
 * Only a root run of a session that labels its runs ({@link RunLabels})
 * qualifies. A resumed run (`resumed`) is described only while it has no
 * `run.description` row, as when its process died before the helper
 * answered, so no run is described twice.
 * Uses the configured helper model, else the run's own, for a one-shot,
 * non-streaming call.
 * On success, commits the run's `run.description` row, which the meta fold
 * and every renderer read, with the request's priced usage, which the run's
 * spend counts. An answer that makes no label has no row to carry its
 * spend, and the warning says so.
 *
 * The helper model is resolved against the session's settings slots
 * (`SessionRoots`) and the process `Secrets` read from context.
 */
const generateSessionDescription = Effect.fn('generateSessionDescription')(
  function* (
    runId: RunId,
    config: AgentConfig,
    agentDescription: string | undefined,
    resumed: boolean,
  ): Effect.fn.Return<
    void,
    never,
    | HttpClient.HttpClient
    | UsageLog
    | RouteRetries
    | Secrets
    | SessionLog
    | SessionRoots
  > {
    const instruction = getDisplayedInstruction(config);
    if (!instruction) return;
    const log = yield* SessionLog;
    const roots = yield* SessionRoots;
    yield* Effect.gen(function* () {
      if (resumed) {
        // A run already described, or one gone, keeps what it has.
        const facts = yield* log.facts(runId);
        if (facts === null || facts.title !== null) return;
      }
      const { text, usage } = yield* helperCall(
        roots,
        {
          userPrompt: buildUserPrompt(
            config.agent,
            agentDescription,
            instruction,
          ),
          systemPrompt: SYSTEM_PROMPT,
        },
        {
          agentName: config.agent,
          runId,
        },
        // No automatic retry and a short deadline: the run's end joins this
        // fiber, and a label is not worth holding it through route backoff.
        { retries: 0, runModel: config.model },
      ).pipe(
        Effect.timeoutOrElse({
          duration: DESCRIPTION_DEADLINE,
          orElse: () =>
            Effect.fail(
              new Error(
                `The helper model did not answer within ${DESCRIPTION_DEADLINE}.`,
              ),
            ),
        }),
      );
      const description = cleanSessionDescription(text);
      // No row to carry the request's spend: say where it went.
      if (!description)
        return yield* Effect.logWarning(
          `The helper's answer for ${runId} makes no session label; its request's spend is not in the run's usage.`,
        ).pipe(withLogChannel(CHANNEL));

      // The description's own row, committed awaited rather than queued behind
      // a drain of the run's publications: this fiber runs beside the run's own
      // (`executeAgent` forks it), so a barrier here would report — and clear —
      // a transcript or trace rollback of the run's, which the catch below
      // would then turn into a warning, leaving the terminal drain to write a
      // COMPLETED row over a fact nobody hears about. A refused commit is this
      // path's own failure and the one thing the warning is for.
      yield* log.transact([
        {
          ...descriptionRow(runId, description, 'model'),
          ...(usage === null ? {} : { usage }),
        },
      ]);
      yield* Effect.logInfo(`Generated session description for ${runId}`).pipe(
        withLogChannel(CHANNEL),
      );
    }).pipe(
      Effect.catch((error) => warnFailure(error)),
      Effect.catchDefect((defect) => warnFailure(defect)),
    );
  },
);

/**
 * `flow` with the run's description made concurrently, on a child fiber of
 * the run's, so the run's stop interrupts it as it interrupts the run. The
 * description finishes as the flow exits, before the lifecycle writes
 * `run.end`: interrupted after a stop, whose label is not worth waiting
 * for, and joined otherwise, so its row lands first. A description
 * committed after `run.end` reads as a fact of a run that has already
 * ended, and could recreate a run another host deleted.
 */
export const withSessionDescription =
  (
    runId: RunId,
    config: AgentConfig,
    agentDescription: string | undefined,
    resumed: boolean,
  ) =>
  <A extends { readonly outcome: RunOutcome }, E, R>(
    flow: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.forkChild(
        generateSessionDescription(runId, config, agentDescription, resumed),
      ),
      () => flow,
      (description, exit) =>
        (
          Exit.isSuccess(exit)
            ? exit.value.outcome === RUN_OUTCOME.CANCELLED
            : Cause.hasInterrupts(exit.cause)
        )
          ? Fiber.interrupt(description)
          : Fiber.join(description),
    );

function warnFailure(cause: unknown): Effect.Effect<void> {
  return Effect.logWarning(
    `Failed to generate session description: ${normalizeProviderError(cause).message}`,
  ).pipe(withLogChannel(CHANNEL));
}
