// Local imports
import {
  isWorkflowTaskState,
  type TaskState,
  type WorkflowTaskState,
} from '@agent/core/state/TaskState';
import type {
  OutputFileInfo,
  RoundIndexed,
  StreamTabId,
} from '@shared/schemas';

export interface WorkflowDiffRequest {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles: string[];
  outputFilesActive: boolean;
  streamId: StreamTabId;
  runId?: string;
  outputsByRound?: RoundIndexed<OutputFileInfo>;
}

export type WorkflowFileOperation = 'pack' | 'clean';

export interface WorkflowFileOperationRequest {
  streamId: StreamTabId;
  agent: string;
  model: string;
  inputFile: string;
  outputFiles: string[];
  executionId?: string;
  skipProgressViewClear: boolean;
}

interface ProgressWorkflowActionsState {
  getTaskState(stream: StreamTabId): TaskState | undefined;
  getExecutionId(stream: StreamTabId): string | undefined;
  getOutputFiles(stream: StreamTabId): RoundIndexed<OutputFileInfo>;
  getKnownWorkspaceOutputPaths(stream: StreamTabId): Set<string>;
}

export interface ProgressWorkflowActionsControllerDeps {
  state: ProgressWorkflowActionsState;
  runDiff(request: WorkflowDiffRequest): Promise<void>;
  runFileOperation(
    operation: WorkflowFileOperation,
    request: WorkflowFileOperationRequest,
  ): Promise<void>;
}

export class ProgressWorkflowActionsController {
  constructor(private readonly deps: ProgressWorkflowActionsControllerDeps) {}

  async diffStream(stream: StreamTabId): Promise<void> {
    await this.withWorkflowTaskState(stream, async (taskState) => {
      // Round keys are non-negative integers by construction (enforced by
      // the shared RoundKeySchema at every write into the snapshot store's
      // accumulator — see `@shared/schemas/roundIndexed.ts`), so this record
      // already enumerates ascending per the ES2015+ integer-key spec rule;
      // runLatexdiffForExecution consumes `outputsByRound` in that order
      // without needing an explicit sort here.
      const runOutputs = this.deps.state.getOutputFiles(stream);
      const outputsByRound = Object.keys(runOutputs).length
        ? runOutputs
        : undefined;

      await this.deps.runDiff({
        agent: taskState.agentConfig.agent,
        model: taskState.agentConfig.model,
        inputFile: taskState.agentConfig.inputFiles[0] ?? '',
        outputFiles: taskState.agentConfig.outputFiles,
        outputFilesActive: taskState.activeFiles.output,
        streamId: stream,
        runId: this.deps.state.getExecutionId(stream),
        outputsByRound,
      });
    });
  }

  async runFileOperation(
    stream: StreamTabId,
    operation: WorkflowFileOperation,
  ): Promise<void> {
    await this.withWorkflowTaskState(stream, async (taskState) => {
      const outputFiles = this.resolveOutputFiles(stream, taskState);
      const executionId = this.deps.state.getExecutionId(stream);

      await this.deps.runFileOperation(operation, {
        streamId: stream,
        agent: taskState.agentConfig.agent,
        model: taskState.agentConfig.model,
        inputFile: taskState.agentConfig.inputFiles[0] ?? '',
        outputFiles,
        ...(executionId && { executionId }),
        skipProgressViewClear: true,
      });
    });
  }

  private async withWorkflowTaskState(
    stream: StreamTabId,
    action: (taskState: WorkflowTaskState) => Promise<void>,
  ): Promise<void> {
    const taskState = this.deps.state.getTaskState(stream);
    if (!taskState || !isWorkflowTaskState(taskState)) return;

    await action(taskState);
  }

  private resolveOutputFiles(
    stream: StreamTabId,
    taskState: WorkflowTaskState,
  ): string[] {
    const generatedPaths = this.deps.state.getKnownWorkspaceOutputPaths(stream);
    return [
      ...new Set(
        [...taskState.agentConfig.outputFiles, ...generatedPaths].filter(
          Boolean,
        ),
      ),
    ];
  }
}
