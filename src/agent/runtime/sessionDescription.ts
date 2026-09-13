/**
 * Session description generation.
 *
 * When a run starts, generates a short AI summary describing what it aims to
 * accomplish, published as the run's `run.description` row so the stream tab,
 * history view, and future agents can quickly understand each session.
 */

import { Effect } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { helperCompletion, helperModel } from '@agent/runtime/helperModel';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { aggregateId as qualifyAggregateId, type RunId } from '@shared/schemas';
import { isNonEmptyString } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

const log = createLog('SessionDescription');
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

const SYSTEM_PROMPT = `Generate a short TeXRA session label from the agent name, description, and user's instruction. Use at most 10 words and no trailing period. Be specific but terse. Use no full sentences, meta-commentary, or quotes. Use present-tense verb phrases (e.g. "Reviewing introduction for clarity", "Fixing TikZ arrow alignment").`;

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
  return (
    (config.displayInstruction?.trim() || config.instruction?.trim()) ?? ''
  );
}

/**
 * Generate and persist a session description from the user's instruction.
 *
 * Started concurrently at the beginning of a run and joined before run
 * ownership is released. Never fails: an unavailable or failing helper is
 * warned about and the run keeps its agent-name label. Stopping the run
 * interrupts it.
 *
 * Every category qualifies. Workflow runs were excluded while "session" meant
 * a tool-use conversation, which left the whole workflow-subagent population —
 * the rows a workflow script's `agent()` calls create, and the ones a reader
 * can least tell apart — labelled by nothing but their agent name.
 * Uses the configured helper model for a one-shot, non-streaming call.
 * On success, commits the run's `run.description` row, which the meta fold
 * and every renderer read.
 *
 * `stores` are the process secret store and global state the run already
 * holds (the `Secrets` / `AppState` services), which the helper model is
 * resolved against.
 */
export const generateSessionDescription = Effect.fn(
  'generateSessionDescription',
)(function* (
  runId: RunId,
  config: AgentConfig,
  agentDescription: string | undefined,
  session: SessionHandle,
  stores: ModelOptionStores,
): Effect.fn.Return<void> {
  const instruction = getDisplayedInstruction(config);
  if (!instruction) return;
  yield* Effect.gen(function* () {
    const bound = yield* helperModel(stores);
    const text = yield* helperCompletion(bound, {
      userPrompt: buildUserPrompt(config.agent, agentDescription, instruction),
      systemPrompt: SYSTEM_PROMPT,
    });
    if (!isNonEmptyString(text)) return;
    const description = cleanSessionDescription(text);
    if (!description) return;

    // The description's own row, committed awaited rather than queued behind
    // a drain of the run's publications: this fiber runs beside the run's own
    // (`executeAgent` forks it), so a barrier here would report — and clear —
    // a transcript or trace rollback of the run's, which the catch below
    // would then turn into a warning, leaving the terminal drain to write a
    // COMPLETED row over a fact nobody hears about. A refused commit is this
    // path's own failure and the one thing the warning is for.
    yield* session.commit([
      {
        type: 'run.description',
        aggregateId: qualifyAggregateId('run', runId),
        description,
      },
    ]);
    log.info(`Generated session description for ${runId}`);
  }).pipe(
    Effect.scoped,
    Effect.catch((error) => warnFailure(error)),
    Effect.catchDefect((defect) => warnFailure(defect)),
  );
});

function warnFailure(cause: unknown): Effect.Effect<void> {
  return Effect.sync(() =>
    log.warn(
      `Failed to generate session description: ${getSdkErrorMessage(cause)}`,
    ),
  );
}
