// Utility for saving debug objects (messages/responses) during debugging

// Standard library imports
import * as path from 'path';

// Local imports
import { WorkspaceFS, StorageFS } from '@utils/files';
import { getRunDir } from '@utils/files/taskRunStorage';
import { getConfig } from '@utils/config';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { AgentLogger } from '@logger/AgentLogger';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

export interface SaveDebugObjectParams {
  object: unknown;
  logger: AgentLogger;
  continuationCount?: number;
  outputFile?: string;
  baseName?: string;
  modelName?: string;
  executionId?: ExecutionId;
  groupId?: string;
  configKey: string;
  label: string;
}

export interface SaveMessagesParams {
  messages: ProviderMessage[];
  logger: AgentLogger;
  continuationCount?: number;
  outputFile?: string;
  baseName?: string;
  /** Name of the model used for this conversation */
  modelName?: string;
  executionId?: ExecutionId;
  groupId?: string;
}

export interface SaveResponseParams {
  responseObject: any;
  logger: AgentLogger;
  continuationCount?: number;
  outputFile?: string;
  baseName?: string;
  modelName?: string;
  executionId?: ExecutionId;
  groupId?: string;
}

async function maybeSaveDebugObject({
  object,
  logger,
  continuationCount,
  outputFile,
  baseName = 'debug',
  modelName,
  executionId,
  groupId,
  configKey,
  label,
}: SaveDebugObjectParams): Promise<void> {
  const shouldSave = getConfig<boolean>(configKey, false);
  if (!shouldSave) {
    return;
  }

  const fileBase =
    outputFile !== undefined
      ? path.basename(outputFile, path.extname(outputFile))
      : baseName;
  const cont =
    continuationCount !== undefined ? `_cont${continuationCount}` : '';
  const modelPart = modelName ? `_${modelName.replace(/[\\/]/g, '_')}` : '';
  const debugFileName = `${fileBase}${modelPart}${cont}.json`;

  const debugFilePath = executionId
    ? path.join(getRunDir(executionId), debugFileName)
    : WorkspaceFS.fullPath(debugFileName);

  try {
    const content = JSON.stringify(object, null, 2);
    if (executionId) {
      await StorageFS.write(debugFilePath, content);
    } else {
      await WorkspaceFS.writeFile(
        WorkspaceFS.relativePath(debugFilePath),
        content,
      );
    }
    logger.info(`Saved ${label} to ${debugFilePath}`, groupId);
  } catch (error) {
    logger.error(`Failed to save ${label}: ${error}`, groupId);
  }
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
  modelName,
  executionId,
  groupId,
}: SaveMessagesParams): Promise<void> {
  await maybeSaveDebugObject({
    object: messages,
    logger,
    continuationCount,
    outputFile,
    baseName,
    modelName,
    executionId,
    groupId,
    configKey: 'debug.saveMessageObjects',
    label: 'message object',
  });
}

export async function maybeSaveResponse({
  responseObject,
  logger,
  continuationCount,
  outputFile,
  baseName = 'response',
  modelName,
  executionId,
  groupId,
}: SaveResponseParams): Promise<void> {
  await maybeSaveDebugObject({
    object: responseObject,
    logger,
    continuationCount,
    outputFile,
    baseName,
    modelName,
    executionId,
    groupId,
    configKey: 'debug.saveResponseObjects',
    label: 'response object',
  });
}
