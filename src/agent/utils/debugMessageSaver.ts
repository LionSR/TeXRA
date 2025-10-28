// Standard library imports
// Utility for saving debug objects (messages/responses) during debugging
import * as path from 'path';

// Local imports - agent
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { AgentLogger } from '@logger/AgentLogger';
import { getConfig } from '@utils/config';

// Local imports
import { WorkspaceFS, StorageFS } from '@utils/files';
import { getRunDir } from '@utils/files/taskRunStorage';

/**
 * Context information for the debug save operation
 */
export interface DebugContext {
  /** Logger instance for the operation */
  logger: AgentLogger;
  /** Model name being used */
  modelName?: string;
  /** Execution ID if part of a task run */
  executionId?: ExecutionId;
  /** Group ID for log correlation */
  groupId?: string;
}

/**
 * File naming and location options
 */
export interface FileOptions {
  /** Output file path (if specific path needed) */
  outputFile?: string;
  /** Base name for the file (e.g., 'messages', 'response') */
  baseName?: string;
  /** Continuation count for multi-part responses */
  continuationCount?: number;
}

/**
 * Type of object being saved (for file naming and logging)
 */
export type DebugObjectType = 'messages' | 'response';

/**
 * Parameters for saving debug objects
 */
export interface SaveDebugParams {
  /** The object to save (messages array or response object) */
  object: ProviderMessage[] | any;
  /** Type of object for file naming */
  objectType: DebugObjectType;
  /** Execution context */
  context: DebugContext;
  /** File options */
  fileOptions?: FileOptions;
}

/**
 * Save debug objects (messages or responses) to a JSON file when
 * `texra.debug.saveDebugObjects` is enabled.
 *
 * @param params - Parameters for saving the debug object
 */
export async function maybeSaveDebugObject({
  object,
  objectType,
  context,
  fileOptions = {},
}: SaveDebugParams): Promise<void> {
  const shouldSave = getConfig<boolean>('debug.saveDebugObjects', false);
  if (!shouldSave) {
    return;
  }

  const { logger, modelName, executionId, groupId } = context;
  const resolvedGroupId = groupId ?? logger.getActiveGroupId();
  const { outputFile, baseName = objectType, continuationCount } = fileOptions;

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
    if (executionId) {
      await StorageFS.writeJson(debugFilePath, object);
    } else {
      await WorkspaceFS.writeJson(
        WorkspaceFS.relativePath(debugFilePath),
        object,
      );
    }
    logger.info(
      `Saved ${objectType} object to ${debugFilePath}`,
      resolvedGroupId,
    );
  } catch (error) {
    logger.error(
      `Failed to save ${objectType} object: ${error}`,
      resolvedGroupId,
    );
  }
}
