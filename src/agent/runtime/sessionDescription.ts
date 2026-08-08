/**
 * Session description generation.
 *
 * When a run starts, generates a short AI summary describing what it aims to
 * accomplish. The description is persisted on the execution metadata and
 * pushed to the progress view so that the stream tab, history view, and
 * future agents can quickly understand each session.
 */

import { getAgent } from '@agent/index';
import { writeSessionDescription } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  createHelperModelKit,
  runHelperModelCompletion,
} from '@agent/runtime/helperModel';
import { getSdkErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { agentKey } from '@shared/schemas/agent';
import { isNonEmptyString } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

const CHANNEL = 'SessionDescription';
const MAX_DESCRIPTION_LENGTH = 80;
const MAX_DESCRIPTION_WORDS = 12;

function warnWithoutRejecting(message: string): void {
  try {
    logger.warn(CHANNEL, message);
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

const SYSTEM_PROMPT = `You generate very short session labels for an AI theorist tool. Given an agent name, its description, and the user's instruction, write a single short phrase (max ~10 words, no trailing period) that captures what the session aims to accomplish. Be specific but terse — no full sentences, no meta-commentary, no quotes. Use present-tense verb phrases (e.g. "Reviewing introduction for clarity", "Fixing TikZ arrow alignment").`;

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
): Promise<void> {
  try {
    const instruction = getDisplayedInstruction(config);
    if (!instruction) return;

    const helperResult = await createHelperModelKit(session);
    if (!helperResult.kit) {
      warnWithoutRejecting(helperResult.reason);
      return;
    }

    const userPrompt = buildUserPrompt(
      config.agent,
      // Resolve the entry the run actually launched: by the pinned source when
      // the launch site captured one (two sources can hold the same name), else
      // under the run's own category — the category argument only orders source
      // priority, and a tool-use lookup cannot see a workflow agent at all.
      getAgent(
        config.agentSource
          ? agentKey(config.agentSource, config.agent)
          : config.agent,
        config.agentCategory,
      )?.description,
      instruction,
    );
    const text = await runHelperModelCompletion(helperResult.kit, {
      userPrompt,
      systemPrompt: SYSTEM_PROMPT,
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
    logger.info(CHANNEL, `Generated session description for ${executionId}`);
  } catch (err) {
    warnWithoutRejecting(
      `Failed to generate session description: ${getSdkErrorMessage(err)}`,
    );
  }
}
