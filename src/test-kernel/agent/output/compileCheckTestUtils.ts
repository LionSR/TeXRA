// Node imports
import * as path from 'node:path';

// Third-party imports
import { Layer } from 'effect';

// Local imports
import { RunFileService } from '@texra-ai/harness/plugins';
import { createRunStorageLocation } from '@texra-ai/harness/host';
import { FakeHost } from '@test/support/testKernel';
import { rootedFsLayer } from '@test/support/fsTestUtils';
import { spiedTrace } from '@test/support/spiedTrace';
import { TEXRA_APP } from '@test/support/texraApp';
import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';
import type { runCompileCheck } from '@texra/agent/output/compileCheck';
import type { FileLocation, RunId } from '@texra-ai/harness/schemas';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  DOCUMENTS_COMPILE_AFTER_OUTPUT_SETTING,
  DOCUMENTS_COMPILE_TIMEOUT_SETTING,
} from '@texra/shared/settingsView/documentsSettings';

/** The rooted filesystems of the test host's roots, over the Node
 *  filesystem. */
export const compileFsLayer = Layer.unwrap(
  FakeHost.useSync(({ roots }) => rootedFsLayer(roots)),
);

export function runDir(roots: WorkspaceRoots, runId: RunId): string {
  return path.join(roots.storage, 'executions', runId);
}

export function runStorageFile(
  roots: WorkspaceRoots,
  runId: RunId,
  relativePath: string,
): FileLocation {
  return createRunStorageLocation(
    path.join(runDir(roots, runId), relativePath),
    relativePath,
    runId,
  );
}

export function outputFile(
  roots: WorkspaceRoots,
  runId: RunId,
  relativePath: string,
  source: string,
  round: number,
): OutputFileInfo {
  return {
    source,
    round,
    location: runStorageFile(roots, runId, relativePath),
    lineage: null,
    diff: null,
  };
}

export function compileContext(
  roots: WorkspaceRoots,
  runId: RunId,
): Parameters<typeof runCompileCheck>[0] {
  return {
    roots,
    fileService: new RunFileService(runId, roots),
    logger: spiedTrace(),
    runId,
    inputDirs: [],
  };
}

/** A host seeded with the workspace/run-storage layout auto-compile reads
 *  through. */
export function latexHost(files: Record<string, string>) {
  return FakeHost.layer({
    app: TEXRA_APP,
    files,
    workspaceState: {
      [DOCUMENTS_COMPILE_AFTER_OUTPUT_SETTING.key]: true,
      [DOCUMENTS_COMPILE_TIMEOUT_SETTING.key]: 30_000,
    },
  });
}
