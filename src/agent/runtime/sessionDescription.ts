/**
 * Session description generation.
 *
 * After a tool-use session completes, generates a short AI summary describing
 * what the session aimed to accomplish. The description is persisted on the
 * execution metadata so that future agents and the history view can quickly
 * understand what each session did.
 */

import { getAgent } from '@agent/index';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { createHelperModelKit } from '@agent/runtime/helperModel';
import { writeSessionDescription } from '@agent/storage';
import * as logger from '@logger/logUtils';
import { isNonEmptyString } from '@utils/core';

import type { ExecutionId } from '@shared/schemas';

const CHANNEL = 'SessionDescription';

const SYSTEM_PROMPT = `You generate concise session descriptions for a LaTeX research assistant tool. Given an agent name, its description, and the user's instruction, write 1-2 sentences summarizing what this session aimed to accomplish. Be specific and informative. Do not include meta-commentary — just the summary. Write in past tense (e.g. "Reviewed the introduction for...").`;

/**
 * Build a user prompt for session description generation.
 */
function buildUserPrompt(
  agentName: string,
  agentDescription: string | undefined,
  instruction: string,
): string {
  const parts = [`Agent: ${agentName}`];
  if (agentDescription) {
    parts.push(`Agent purpose: ${agentDescription}`);
  }
  parts.push(`User instruction: ${instruction}`);
  return parts.join('\n');
}

/**
 * Generate and persist a session description for a completed execution.
 *
 * Runs fire-and-forget — never throws. Uses the configured helper model
 * for a one-shot, non-streaming call.
 */
export async function generateSessionDescription(
  executionId: ExecutionId,
  config: AgentConfig,
): Promise<void> {
  try {
    const instruction = config.instruction?.trim();
    if (!instruction) return;

    const agentEntry = getAgent(config.agent, true);
    const agentDescription = agentEntry?.description;

    const kit = await createHelperModelKit();
    if (!kit) {
      logger.warn(CHANNEL, 'Helper model not available for session description');
      return;
    }

    const { handler, client } = kit;
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
      logger.info(CHANNEL, `Generated session description for ${executionId}`);
    }
  } catch (err) {
    logger.warn(CHANNEL, `Failed to generate session description`, {
      data: err,
    });
  }
}
