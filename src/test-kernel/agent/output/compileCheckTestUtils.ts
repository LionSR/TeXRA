// Node imports
import * as path from 'node:path';

// Local imports
import { RunFileService } from '@texra-ai/harness/plugins';
import { createRunStorageLocation } from '@texra-ai/harness/host';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { fakePath } from '@test/support/FakePlatform';
import { FakeHost } from '@test/support/testKernel';
import { rootedFsLayer } from '@test/support/fsTestUtils';
import { spiedTrace } from '@test/support/spiedTrace';
import { TEXRA_APP } from '@test/support/texraApp';
import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';
import type { runCompileCheck } from '@texra/agent/output/compileCheck';
import type { FileLocation, RunId } from '@texra-ai/harness/schemas';
import {
  WORKFLOW_AUTO_COMPILE_SETTING,
  WORKFLOW_AUTO_COMPILE_TIMEOUT_SETTING,
} from '@texra/shared/settingsView/documentsSettings';

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
): Parameters<typeof runCompileCheck>[0] {
  return {
    // The installed fake host's roots: these suites seed and read one host.
    roots: testWorkspaceRoots(),
    fileService: new RunFileService(runId, testWorkspaceRoots()),
    logger: spiedTrace(),
    runId,
  };
}

/** A host seeded with the workspace/run-storage layout auto-compile reads
 *  through. */
export function latexHost(files: Record<string, string>) {
  return FakeHost.layer({
    app: TEXRA_APP,
    files,
    storagePath,
    workspacePath,
    workspaceState: {
      [WORKFLOW_AUTO_COMPILE_SETTING.key]: true,
      [WORKFLOW_AUTO_COMPILE_TIMEOUT_SETTING.key]: 30_000,
    },
  });
}
