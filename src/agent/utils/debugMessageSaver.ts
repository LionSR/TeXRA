import * as path from 'node:path';

import type { AgentTrace } from '@agent/trace';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import type { ExecutionId } from '@shared/schemas';
import { WorkspaceFS, StorageFS } from '@utils/files';
import { getConfig } from '@utils/config/configUtils';
import { ensureRunDir } from '@utils/files/taskRunStorage';

interface DebugContext {
  logger: AgentTrace;
  modelName?: string;
  executionId?: ExecutionId;
  /** Remote agents skip saving to avoid leaking prompts. */
  isRemote?: boolean;
}

interface DebugSaveOptions {
  outputFile?: string;
  /** Base name for the file (e.g. 'messages', 'response'). */
  baseName?: string;
  continuationCount?: number;
}

type DebugObjectType = 'messages' | 'response';

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
      ? path.join(RUNS_STORAGE_DIR, executionId, debugFileName)
      : debugFileName;
    const fs = executionId ? StorageFS : WorkspaceFS;

    if (executionId) await ensureRunDir(executionId);
    await fs.writeJson(filePath, object);

    const debugFilePath = fs.fullPath(filePath);
    logger.info(`Saved ${objectType} object to ${debugFilePath}`);
  } catch (error) {
    logger.error(`Failed to save ${objectType} object`, { data: error });
  }
}
