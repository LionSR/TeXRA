/**
 * Handler for resume_tool follow-up items.
 *
 * Processes structured resume_tool items from the follow-up queue by
 * sending a follow-up instruction to the specified subagent. This allows
 * the orchestrator to resume subagents via queued follow-ups rather than
 * requiring a tool-call cycle through the resume_agent tool.
 *
 * This module is VS Code-agnostic and stays within the agent layer.
 */

import {
  getHandle,
  AgentExecutionHandle,
} from '@agent/runtime/executionRegistry';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { AgentLogger } from '@logger/AgentLogger';
import type { FollowUpItem } from './FollowUpQueue';

const logger = new AgentLogger('resumeToolHandler');

/**
 * Handle a resume_tool follow-up item by sending the instruction
 * to the specified subagent's stream.
 *
 * Unlike the resume_agent tool, this handler:
 * - Does not manage delivery gates (those are DelegationTools-specific)
 * - Logs errors instead of throwing (non-fatal — the orchestrator continues)
 * - Does not validate delivery state (the caller already decided to resume)
 */
export async function handleResumeToolFollowUp(
  item: Extract<FollowUpItem, { kind: 'resume_tool' }>,
): Promise<void> {
  const handle = getHandle(item.executionId);
  if (!(handle instanceof AgentExecutionHandle)) {
    logger.warn(
      `Cannot resume: execution '${item.executionId}' not found or not an agent execution.`,
    );
    return;
  }

  if (handle.category !== 'toolUse') {
    logger.warn(
      `Cannot resume: execution '${item.executionId}' is a ${handle.category} agent, not tool-use.`,
    );
    return;
  }

  // Frame the instruction so the subagent knows it's from the orchestrator
  const framedInstruction = [
    '<orchestrator-followup>',
    item.instruction,
    '</orchestrator-followup>',
  ].join('\n');

  const result = await sendFollowUp(handle.childStreamId, framedInstruction);

  switch (result.status) {
    case 'sent':
    case 'queued':
      logger.info(
        `Resume follow-up ${result.status} for '${handle.agentName}' (${item.executionId}).`,
      );
      break;
    case 'error':
      logger.warn(
        `Failed to resume '${handle.agentName}': ${result.message}`,
      );
      break;
    case 'no_session':
      logger.warn(
        `No active session for '${handle.agentName}' (status: ${result.streamStatus ?? 'unknown'}).`,
      );
      break;
  }
}
