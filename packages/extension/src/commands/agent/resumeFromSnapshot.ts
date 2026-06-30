/**
 * Shared snapshot-driven resume helper.
 *
 * Used by:
 *   - `texra.sendFollowUp` (auto-resume when a follow-up lands on a
 *     WAITING / children_running stream).
 *   - `AgentResumePort.tryResumeStream` (inquiry continuation path).
 */
import * as vscode from 'vscode';

import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  retrieveSessionResumeData,
  type SessionResumeData,
} from '@agent/runtime/SessionResumeRetrieval';
import { createChannelTrace } from '@logger';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { StreamTabId } from '@shared/schemas';

import { ResumeAgentResultSchema } from './resumeCommand';

const logger = createChannelTrace('resumeFromSnapshot');

export async function tryResumeFromSnapshot(
  streamId: StreamTabId,
): Promise<boolean> {
  if (StreamStatusService.isActiveOrResuming(streamId)) {
    logger.debug(`Stream ${streamId} is active/resuming, skipping auto-resume`);
    return false;
  }

  const progressState = ProgressViewProvider.getInstance()?.state;
  const executionId = progressState?.snapshots.getExecutionId(streamId);
  const taskState = progressState?.snapshots.getTaskState(streamId);

  if (!progressState) {
    logger.warn(`No ProgressViewProvider found for stream: ${streamId}`);
    return false;
  }
  if (!executionId) {
    logger.warn(`No execution ID found for stream: ${streamId}`);
    return false;
  }
  if (!taskState) {
    logger.warn(`No task state found for stream: ${streamId}`);
    return false;
  }

  let resumeData: SessionResumeData | null;
  try {
    resumeData = await retrieveSessionResumeData(
      streamId,
      executionId,
      taskState,
    );
  } catch (error) {
    // Retrieval failed unexpectedly (distinct from "no resumable session").
    // Auto-resume is best-effort here, so degrade, but log the real failure
    // rather than letting it masquerade as "nothing to resume".
    logger.error(`Failed to retrieve resume data for stream: ${streamId}`, {
      data: error,
    });
    return false;
  }
  if (!resumeData) return false;

  logger.info(
    `Auto-resuming ${resumeData.type} session for stream: ${streamId}`,
  );
  try {
    if (resumeData.type === 'toolUse') {
      const rawResult = await vscode.commands.executeCommand(
        'texra.resumeAgent',
        { snapshot: resumeData.snapshot },
      );
      const parseResult = ResumeAgentResultSchema.safeParse(rawResult);
      return parseResult.success && parseResult.data.success;
    }
    // Workflow: execute returns void - success if no exception thrown
    await vscode.commands.executeCommand('texra.execute', {
      config: resumeData.agentConfig,
      executionId: resumeData.executionId,
      modelHandlerCompatibilityKey: resumeData.modelHandlerCompatibilityKey,
    });
    return true;
  } catch (error) {
    logger.error(`Failed to execute resume command for stream: ${streamId}`, {
      data: error,
    });
    return false;
  }
}
