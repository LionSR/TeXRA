// Utility for saving message objects during debugging

// Standard library imports
import * as path from 'path';

// Local imports
import { WorkspaceFS, StorageFS } from '@utils/files';
import { getRunDir } from '@utils/files/taskRunStorage';
import { getConfig } from '@utils/config';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { AgentLogger } from '@logger/AgentLogger';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

export interface SaveMessagesParams {
  messages: ProviderMessage[];
  logger: AgentLogger;
  continuationCount?: number;
  outputFile?: string;
  baseName?: string;
  executionId?: ExecutionId;
  groupId?: string;
}

/**
 * Save conversation message objects to a JSON file when
 * `texra.debug.saveMessageObjects` is enabled.
 */
export async function maybeSaveMessages({
  messages,
  logger,
  continuationCount,
  outputFile,
  baseName = 'messages',
  executionId,
  groupId,
}: SaveMessagesParams): Promise<void> {
  const shouldSave = getConfig<boolean>('debug.saveMessageObjects', false);
  if (!shouldSave) {
    return;
  }

  const fileBase =
    outputFile !== undefined
      ? path.basename(outputFile, path.extname(outputFile))
      : baseName;
  const cont =
    continuationCount !== undefined ? `_cont${continuationCount}` : '';
  const debugFileName = `${fileBase}${cont}.json`;

  const debugFilePath = executionId
    ? path.join(getRunDir(executionId), debugFileName)
    : WorkspaceFS.fullPath(debugFileName);

  try {
    const content = JSON.stringify(messages, null, 2);
    if (executionId) {
      await StorageFS.write(debugFilePath, content);
    } else {
      await WorkspaceFS.writeFile(
        WorkspaceFS.relativePath(debugFilePath),
        content,
      );
    }
    logger.info(`Saved message object to ${debugFilePath}`, groupId);
  } catch (error) {
    logger.error(`Failed to save message object: ${error}`, groupId);
  }
}
