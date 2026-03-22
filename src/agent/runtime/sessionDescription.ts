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
import { createHelperModelKit } from '@agent/runtime/helperModel';
import { bus } from '@eventBus/ProgressEventBus';
import * as logger from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { isNonEmptyString } from '@utils/core';

const CHANNEL = 'SessionDescription';

const SYSTEM_PROMPT = `You generate concise session descriptions for a LaTeX research assistant tool. Given an agent name, its description, and the user's instruction, write 1-2 sentences summarizing what this session aims to accomplish. Be specific and informative. Do not include meta-commentary — just the summary. Write in present tense (e.g. "Reviews the introduction for...").`;

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
      // Collapse newlines to prevent corrupting line-based tool output.
      const description = text.trim().replaceAll(/\s*\n\s*/g, ' ');
      await writeSessionDescription(executionId, description);
      bus.emit('updateStreamDescription', { streamId, description });
      logger.info(CHANNEL, `Generated session description for ${executionId}`);
    }
  } catch (err) {
    logger.warn(CHANNEL, `Failed to generate session description`, {
      data: err,
    });
  }
}
