// Node imports
import * as path from 'node:path';

// Local imports
import type { runCompileCheck } from '@agent/implementations/flows/reflection/output/compileCheck';
import type { OutputState } from '@agent/implementations/flows/reflection/output/outputState';
import type { RunId, FileLocation, OutputFileInfo } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
import { spiedTrace } from '@test/support/spiedTrace';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

export const storagePath = '/storage';
export const workspacePath = '/workspace';

export function runDir(executionId: RunId): string {
  return path.join(storagePath, 'executions', executionId);
}

export function runStorageFile(
  executionId: RunId,
  relativePath: string,
): FileLocation {
  return createRunStorageLocation(
    path.join(runDir(executionId), relativePath),
    relativePath,
    executionId,
  );
}

export function outputFile(
  executionId: RunId,
  relativePath: string,
  source: string,
  round: number,
): OutputFileInfo {
  return {
    source,
    round,
    location: runStorageFile(executionId, relativePath),
    lineage: null,
    diff: null,
  };
}

export function compileContext(
  executionId: RunId,
  outputState: OutputState,
): Parameters<typeof runCompileCheck>[0] {
  return {
    fileService: new TaskRunFileService(executionId),
    outputState,
    logger: spiedTrace(),
    streamId: 'compile-stream',
  };
}

/** Seeds the workspace/run-storage layout auto-compile reads through. */
export function initLatexPlatform(
  files: Record<string, string>,
): Promise<void> {
  return installPlatform({
    files,
    storagePath,
    workspacePath,
    workspaceState: {
      [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]: true,
      [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]: 30_000,
    },
  });
}
