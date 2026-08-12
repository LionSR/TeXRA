/**
 * Session description generation.
 *
 * When a run starts, generates a short AI summary describing what it aims to
 * accomplish. The description is persisted on the execution metadata and
 * pushed to the progress view so that the stream tab, history view, and
 * future agents can quickly understand each session.
 */

import { resolveAgentForLaunch } from '@agent/index';
import { writeSessionDescription } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  createHelperModelKit,
  runHelperModelCompletion,
} from '@agent/runtime/helperModel';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { isNonEmptyString } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

const log = createLog('SessionDescription');
const MAX_DESCRIPTION_LENGTH = 80;
const MAX_DESCRIPTION_WORDS = 12;

function warnWithoutRejecting(message: string): void {
  try {
    log.warn(message);
  } catch {
    // Best-effort diagnostics must not make description generation reject.
  }
}

/**
 * Normalize a model-generated session description: collapse newlines,
 * strip surrounding quotes/backticks, drop trailing sentence punctuation,
 * and truncate to a UI-friendly length. Returns an empty string when the
 * cleaned result has no meaningful content.
 */
export function cleanSessionDescription(text: string): string {
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
 * Started concurrently at the beginning of a run and joined before execution
 * ownership is released. Never throws.
 *
 * Every category qualifies. Workflow runs were excluded while "session" meant
 * a tool-use conversation, which left the whole workflow-subagent population —
 * the rows a workflow script's `agent()` calls create, and the ones a reader
 * can least tell apart — labelled by nothing but their agent name.
 * Uses the configured helper model for a one-shot, non-streaming call.
 * On success, persists the description to execution metadata and emits
 * an `updateStreamDescription` event so the progress view can display it.
 */
export async function generateSessionDescription(
  executionId: ExecutionId,
  streamId: StreamTabId,
  config: AgentConfig,
  session: SessionHandle,
  signal?: AbortSignal,
): Promise<void> {
  try {
    signal?.throwIfAborted();
    const instruction = getDisplayedInstruction(config);
    if (!instruction) return;

    const helperResult = await createHelperModelKit(session);
    signal?.throwIfAborted();
    if (!helperResult.kit) {
      warnWithoutRejecting(helperResult.reason);
      return;
    }

    const userPrompt = buildUserPrompt(
      config.agent,
      // The launch resolver, not a lookup of our own: `getAgentPath` is a thin
      // wrapper over this same call, so the purpose we describe always belongs
      // to the entry that actually ran. Any other resolver can diverge — by
      // category, by pinned source, or by picking a higher-priority same-name
      // agent the visible roster did not select — and label a run with a
      // different agent's purpose.
      resolveAgentForLaunch(
        config.agentCategory,
        config.agent,
        config.agentSource,
      )?.entry.description,
      instruction,
    );
    const text = await runHelperModelCompletion(helperResult.kit, {
      userPrompt,
      systemPrompt: SYSTEM_PROMPT,
      signal,
    });

    if (!isNonEmptyString(text)) return;
    const description = cleanSessionDescription(text);
    if (!description) return;

    await writeSessionDescription(executionId, description);
    session.events.emit({
      scope: 'session',
      event: {
        type: 'updateStreamDescription',
        payload: { streamId, description },
      },
    });
    log.info(`Generated session description for ${executionId}`);
  } catch (err) {
    warnWithoutRejecting(
      `Failed to generate session description: ${getSdkErrorMessage(err)}`,
    );
  }
}
