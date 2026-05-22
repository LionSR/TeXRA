import * as path from 'path';

import { getConfig } from '@agent/core/config';
import { toErrorMessage } from '@common/errors';
import { AgentLogger } from '@logger/AgentLogger';
import type { ExecutionId } from '@shared/schemas';
import { WorkspaceFS, StorageFS } from '@utils/files';
import { ensureRunDir, TASK_RUNS_DIR } from '@utils/files/taskRunStorage';

export interface DebugContext {
  logger: AgentLogger;
  modelName?: string;
  executionId?: ExecutionId;
  /** Remote agents skip saving to avoid leaking prompts. */
  isRemote?: boolean;
}

export interface DebugSaveOptions {
  outputFile?: string;
  /** Base name for the file (e.g. 'messages', 'response'). */
  baseName?: string;
  continuationCount?: number;
}

export type DebugObjectType = 'messages' | 'response';

export interface SaveDebugParams {
  object: unknown;
  objectType: DebugObjectType;
  context: DebugContext;
  fileOptions?: DebugSaveOptions;
}

/**
 * Save debug objects (messages or responses) to a JSON file when
 * `texra.debug.saveDebugObjects` is enabled. Skips remote agents to avoid
 * leaking prompts.
 */
export async function maybeSaveDebugObject({
  object,
  objectType,
  context,
  fileOptions = {},
}: SaveDebugParams): Promise<void> {
  const shouldSave = getConfig<boolean>('texra.debug.saveDebugObjects', false);
  if (!shouldSave || context.isRemote) return;

  const { logger, modelName, executionId } = context;
  const { outputFile, baseName = objectType, continuationCount } = fileOptions;

  const fileBase = outputFile
    ? path.basename(outputFile, path.extname(outputFile))
    : baseName;
  const cont = continuationCount ? `_cont${continuationCount}` : '';
  const modelPart = modelName ? `_${modelName.replaceAll(/[\\/]/g, '_')}` : '';
  const debugFileName = `${fileBase}${modelPart}${cont}.json`;

  try {
    // Use appropriate file system based on whether we have an execution context
    const filePath = executionId
      ? path.join(TASK_RUNS_DIR, executionId, debugFileName)
      : debugFileName;
    const fs = executionId ? StorageFS : WorkspaceFS;

    if (executionId) await ensureRunDir(executionId);
    await fs.writeJson(filePath, object);

    const debugFilePath = fs.fullPath(filePath);
    logger.info(`Saved ${objectType} object to ${debugFilePath}`);
  } catch (error) {
    logger.error(
      `Failed to save ${objectType} object: ${toErrorMessage(error)}`,
    );
  }
}
