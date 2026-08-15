import * as path from 'node:path';

import type { AgentTrace } from '@agent/trace';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files/storageFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { getConfig } from '@utils/config/configUtils';
import { ensureRunDir } from '@utils/files/runStorageFs';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

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

/**
 * Whether to persist what TeXRA sends to and receives from the model.
 *
 * The one current setting covers request messages, responses, and the final
 * input prompt.
 */
export function shouldSaveModelIO(): boolean {
  return getConfig<boolean>('texra.debug.saveModelIO', false);
}

interface SaveDebugParams {
  object: unknown;
  objectType: DebugObjectType;
  context: DebugContext;
  fileOptions?: DebugSaveOptions;
}

/**
 * Save debug objects (messages or responses) to a JSON file when
 * `texra.debug.saveModelIO` is enabled. Skips remote agents to avoid
 * leaking prompts.
 */
export async function maybeSaveDebugObject({
  object,
  objectType,
  context,
  fileOptions = {},
}: SaveDebugParams): Promise<void> {
  if (!shouldSaveModelIO() || context.isRemote) return;

  const { logger, modelName, executionId } = context;
  const { outputFile, baseName = objectType, continuationCount } = fileOptions;

  const fileBase = outputFile
    ? path.basename(outputFile, path.extname(outputFile))
    : baseName;
  const cont = continuationCount ? `_cont${continuationCount}` : '';
  const modelPart = modelName
    ? `_${sanitizePathSegment(modelName, { invalidCharPattern: /[\\/]/g, replacement: '_' })}`
    : '';
  const debugFileName = `${fileBase}${modelPart}${cont}.json`;

  try {
    const filePath = executionId
      ? resolveRunStoragePath(executionId, debugFileName)
      : debugFileName;
    const fs = executionId ? StorageFS : WorkspaceFS;

    if (executionId) await ensureRunDir(executionId);
    await fs.write(filePath, JSON.stringify(object, null, 2));

    const debugFilePath = fs.fullPath(filePath);
    logger.info(`Saved ${objectType} object to ${debugFilePath}`);
  } catch (error) {
    logger.error(`Failed to save ${objectType} object`, { data: error });
  }
}
