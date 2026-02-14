/**
 * Tool for sending follow-up instructions to a waiting tool-use subagent.
 *
 * Enables the orchestrator to iteratively refine subagent work without
 * re-launching: the subagent delivers its initial result via onBeforeWaiting,
 * the orchestrator reviews it, then uses this tool to send further instructions.
 * The subagent resumes from its persisted state with the new instruction.
 */

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent
import { STREAM_STATUS, ExecutionIdSchema } from '@shared/schemas';
import {
  sendSubagentFollowUp,
  type SendSubagentFollowUpResult,
} from '@agent/toolUse/ToolUseFollowUp';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  getHandle,
  AgentExecutionHandle,
} from '@agent/runtime/executionRegistry';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { ResumeAgentResultSchema } from '@commands/agent/resumeCommand';

// Local imports - tools
import { ToolError, type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - logger
import { AgentLogger } from '@logger/AgentLogger';

const logger = new AgentLogger('ResumeSubagentTool');

// ============================================================================
// Schema
// ============================================================================

const ResumeSubagentInputSchema = z.strictObject({
  execution_id: ExecutionIdSchema.describe(
    'Execution ID of the tool-use subagent to resume. Use /executions to find the ID.',
  ),
  instruction: z
    .string()
    .describe(
      'Follow-up instruction for the subagent. Write as a self-contained message—the subagent will see this as a new user message in its conversation.',
    ),
});

export type ResumeSubagentInput = z.infer<typeof ResumeSubagentInputSchema>;

// ============================================================================
// Auto-resume logic (mirrors followUpCommand.tryAutoResume for programmatic use)
// ============================================================================

/**
 * Attempt to auto-resume a WAITING tool-use subagent after queuing a follow-up.
 *
 * This mirrors the logic in followUpCommand.ts but works without VS Code
 * command dispatching for the lookup — it resolves the snapshot directly.
 */
async function tryAutoResumeSubagent(
  handle: AgentExecutionHandle,
): Promise<boolean> {
  const streamId = handle.childStreamId;

  // Guard against concurrent resume attempts
  if (StreamStatusService.isActiveOrResuming(streamId)) {
    logger.debug(
      `Stream ${streamId} is active/resuming, skipping auto-resume`,
    );
    return false;
  }

  const progressState = ProgressViewProvider.getInstance()?.state;
  const executionId = progressState?.getExecutionId(streamId);
  const taskState = progressState?.getTaskState(streamId);

  if (!progressState || !executionId || !taskState) {
    logger.warn(`Missing state for auto-resume of stream: ${streamId}`);
    return false;
  }

  const resumeData = await retrieveSessionResumeData(
    streamId,
    executionId,
    taskState,
  );
  if (!resumeData || resumeData.type !== 'toolUse') {
    logger.warn(`No tool-use resume data for stream: ${streamId}`);
    return false;
  }

  logger.info(`Auto-resuming subagent for stream: ${streamId}`);
  try {
    const rawResult = await vscode.commands.executeCommand(
      'texra.resumeAgent',
      { snapshot: resumeData.snapshot },
    );
    const parseResult = ResumeAgentResultSchema.safeParse(rawResult);
    return parseResult.success && parseResult.data.success;
  } catch (error) {
    logger.error(`Failed to auto-resume subagent for stream: ${streamId}`, {
      data: error,
    });
    return false;
  }
}

// ============================================================================
// Tool
// ============================================================================

export class ResumeSubagentTool extends defineTool({
  name: 'resume_subagent',
  description: `Send a follow-up instruction to a waiting tool-use subagent and resume it.

When a tool-use subagent finishes its initial work, it delivers its result and enters a WAITING state. Use this tool to send additional instructions so it continues from where it left off—without re-launching.

Typical flow:
1. delegate_agent launches a subagent
2. Subagent delivers result as a follow-up message
3. You review the result and decide refinement is needed
4. Use resume_subagent with the subagent's execution ID and new instruction
5. Subagent resumes and delivers the refined result

The subagent must be in WAITING state (check via executions tool). If the subagent has already exited, use delegate_agent to launch a new one.`,
  schema: ResumeSubagentInputSchema,
}) {
  protected async execute(input: ResumeSubagentInput): Promise<ToolResult> {
    const { execution_id: executionId, instruction } = input;

    // Validate handle exists and is a tool-use agent
    const handle = getHandle(executionId);
    if (!handle) {
      throw new ToolError(
        `Execution not found: ${executionId}. The subagent may have already exited. Use delegate_agent to launch a new one.`,
      );
    }

    if (!(handle instanceof AgentExecutionHandle)) {
      throw new ToolError(
        `Execution ${executionId} is a background process, not an agent. Use resume_subagent only with tool-use subagents.`,
      );
    }

    if (handle.category !== 'toolUse') {
      throw new ToolError(
        `Execution ${executionId} is a workflow agent ('${handle.agentName}'). resume_subagent only works with tool-use subagents.`,
      );
    }

    // Check stream status for clear messaging
    const streamStatus = StreamStatusService.get(handle.childStreamId);
    if (
      streamStatus === STREAM_STATUS.RUNNING ||
      streamStatus === STREAM_STATUS.RESUMING
    ) {
      throw new ToolError(
        `Subagent '${handle.agentName}' (${executionId}) is currently ${streamStatus}. Wait for it to finish or enter WAITING state before sending a follow-up.`,
      );
    }

    // Route the follow-up to the subagent's stream
    const result: SendSubagentFollowUpResult = await sendSubagentFollowUp(
      executionId,
      instruction,
    );

    switch (result.status) {
      case 'sent':
        return {
          summary: `Follow-up sent to '${handle.agentName}'`,
          output: `Follow-up delivered to subagent '${handle.agentName}' (${executionId}). The subagent is actively processing.`,
        };

      case 'queued':
        if (result.reason === 'waiting') {
          // Trigger auto-resume for WAITING sessions
          const resumed = await tryAutoResumeSubagent(handle);
          if (resumed) {
            return {
              summary: `Resumed '${handle.agentName}' with follow-up`,
              output: [
                `Subagent '${handle.agentName}' (${executionId}) has been resumed with your follow-up instruction.`,
                `Result will be delivered automatically as a follow-up message when complete.`,
              ].join('\n'),
            };
          }
          return {
            summary: `Follow-up queued for '${handle.agentName}'`,
            output: [
              `Follow-up queued for subagent '${handle.agentName}' (${executionId}).`,
              `Auto-resume failed — the subagent will process the instruction when manually resumed.`,
            ].join('\n'),
            isError: true,
          };
        }
        // reason === 'resuming': already being resumed
        return {
          summary: `Follow-up queued for '${handle.agentName}' (resuming)`,
          output: `Subagent '${handle.agentName}' (${executionId}) is currently resuming. Your follow-up has been queued and will be processed after the current resume completes.`,
        };

      case 'error':
        return {
          summary: `Failed to send follow-up to '${handle.agentName}'`,
          output: `Error sending follow-up to subagent '${handle.agentName}' (${executionId}): ${result.message}`,
          isError: true,
        };

      case 'not_found':
        throw new ToolError(
          `Could not route follow-up to execution ${executionId}: ${result.reason}`,
        );
    }
  }
}
