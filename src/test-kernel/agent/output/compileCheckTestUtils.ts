// Node imports
import * as path from 'node:path';

// Local imports
import type { runCompileCheck } from '@agent/output/compileCheck';
import type { OutputState } from '@agent/output/outputState';
import type { RunId, FileLocation, OutputFileInfo } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { rootedFsLayer } from '@test/support/fsTestUtils';
import { spiedTrace } from '@test/support/spiedTrace';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { RunFileService } from '@utils/files/runStorage';

export const storagePath = fakePath('storage');
export const workspacePath = fakePath('workspace');

/** The rooted filesystems of the seeded roots, over the Node filesystem. */
export const compileFsLayer = rootedFsLayer({
  workspace: workspacePath,
  storage: storagePath,
  globalStorage: fakePath('global-storage'),
});

export function runDir(runId: RunId): string {
  return path.join(storagePath, 'executions', runId);
}

export function runStorageFile(
  runId: RunId,
  relativePath: string,
): FileLocation {
  return createRunStorageLocation(
    path.join(runDir(runId), relativePath),
    relativePath,
    runId,
  );
}

export function outputFile(
  runId: RunId,
  relativePath: string,
  source: string,
  round: number,
): OutputFileInfo {
  return {
    source,
    round,
    location: runStorageFile(runId, relativePath),
    lineage: null,
    diff: null,
  };
}

export function compileContext(
  runId: RunId,
  outputState: OutputState,
): Parameters<typeof runCompileCheck>[0] {
  return {
    // The installed fake host's roots: these suites seed and read one host.
    roots: testWorkspaceRoots(),
    fileService: new RunFileService(runId, testWorkspaceRoots()),
    outputState,
    logger: spiedTrace(),
    runId,
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
