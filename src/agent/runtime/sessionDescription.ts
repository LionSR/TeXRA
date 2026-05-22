/**
 * Session description generation.
 *
 * When a tool-use session starts, generates a short AI summary describing
 * what the session aims to accomplish. The description is persisted on the
 * execution metadata and pushed to the progress view so that the stream tab,
 * history view, and future agents can quickly understand each session.
 */

import { getAgent } from '@agent/index';
import { writeSessionDescription } from '@agent/storage';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createHelperModelKit } from '@agent/runtime/helperModel';
import * as logger from '@agent/core/logger';
import { toErrorMessage } from '@common/errors/errorMessage';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { isNonEmptyString } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

const CHANNEL = 'SessionDescription';
const MAX_DESCRIPTION_LENGTH = 80;

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
  return truncateWithEllipsis(cleaned, MAX_DESCRIPTION_LENGTH);
}

const SYSTEM_PROMPT = `You generate very short session labels for a LaTeX research assistant tool. Given an agent name, its description, and the user's instruction, write a single short phrase (max ~10 words, no trailing period) that captures what the session aims to accomplish. Be specific but terse — no full sentences, no meta-commentary, no quotes. Use present-tense verb phrases (e.g. "Reviewing introduction for clarity", "Fixing TikZ arrow alignment").`;

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
 * Generate and persist a session description from the user's instruction.
 *
 * Called fire-and-forget at the start of a tool-use session — never throws.
 * Uses the configured helper model for a one-shot, non-streaming call.
 * On success, persists the description to execution metadata and emits
 * an `updateStreamDescription` event so the progress view can display it.
 */
export async function generateSessionDescription(
  executionId: ExecutionId,
  streamId: StreamTabId,
  config: AgentConfig,
  runtimeHost: AgentRuntimeHost,
): Promise<void> {
  try {
    const instruction = config.instruction?.trim();
    if (!instruction) return;

    const agentEntry = getAgent(config.agent, true);
    const agentDescription = agentEntry?.description;

    const helperResult = await createHelperModelKit();
    if (!helperResult.kit) {
      logger.warn(CHANNEL, helperResult.reason);
      return;
    }

    const { handler, client } = helperResult.kit;
    const userPrompt = buildUserPrompt(
      config.agent,
      agentDescription,
      instruction,
    );
    const messages = await handler.initializeMessages(
      '',
      userPrompt,
      undefined,
      SYSTEM_PROMPT,
    );
    const result = await handler.createResponse({
      client,
      messages,
      temperature: 0,
      systemPrompt: SYSTEM_PROMPT,
    });
    const { text } = handler.extractResponse(result.response, '');

    if (isNonEmptyString(text)) {
      const description = cleanSessionDescription(text);
      if (!description) return;
      await writeSessionDescription(executionId, description);
      runtimeHost.emit('updateStreamDescription', {
        streamId,
        description,
      });
      logger.info(CHANNEL, `Generated session description for ${executionId}`);
    }
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to generate session description: ${toErrorMessage(err)}`,
    );
  }
}
