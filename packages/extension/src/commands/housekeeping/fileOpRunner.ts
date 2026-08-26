// Local imports
import {
  mergeRunDirAndWorkspaceResult,
  type ExecutionId,
  type FileOpResult,
} from '@shared/schemas';

// The clean schema is the source of truth for the fields both file operations
// share; the pack config is structurally assignable to it.
import type { CleanConfig as FileOpConfig } from './fileOpSchemas';

/** The per-operation primitives a file operation (clean or pack) supplies. */
interface FileOpActions {
  readonly runSingle: (
    model: string,
    inputFile: string,
    agent: string,
  ) => Promise<FileOpResult>;
  readonly runMultiple: (
    model: string,
    inputFile: string,
    agent: string,
    inputFiles: string[],
  ) => Promise<FileOpResult>;
  readonly runRunDir: (
    executionId: ExecutionId,
    agent: string,
    model: string,
    inputFile: string,
  ) => Promise<FileOpResult>;
  readonly showResult: (result: FileOpResult, inputFile: string) => void;
}

/**
 * Shared toolbar orchestration for the housekeeping file operations: run the
 * workspace op (multiple or single by `outputFiles` count), merge the runDir
 * leg when an `executionId` is present, then surface the result.
 */
export async function runFileOp(
  config: FileOpConfig,
  actions: FileOpActions,
): Promise<void> {
  const { agent, model, inputFile, outputFiles, executionId } = config;

  const runWorkspaceOp = (): Promise<FileOpResult> =>
    outputFiles.length > 0
      ? actions.runMultiple(model, inputFile, agent, outputFiles)
      : actions.runSingle(model, inputFile, agent);

  // Toolbar-driven invocations pass an executionId: run the runDir leg AND the
  // workspace sweep. The workspace sweep is a no-op for new runs (their outputs
  // live only inside the runDir), but it catches legacy runs whose outputs
  // still sit beside the source — keying solely off the runDir result leaves
  // those real artifacts behind.
  let result: FileOpResult;
  if (executionId) {
    const runDirResult = await actions.runRunDir(
      executionId,
      agent,
      model,
      inputFile,
    );
    const workspaceResult = await runWorkspaceOp();
    result = mergeRunDirAndWorkspaceResult(runDirResult, workspaceResult);
  } else {
    result = await runWorkspaceOp();
  }
  actions.showResult(result, inputFile);
}
