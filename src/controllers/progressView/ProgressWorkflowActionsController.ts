// Local imports - agent
import type { ExecutionRequest } from '@agent/core/executionRequests';

// Local imports - logger
import {
  isWorkflowTaskState,
  type TaskState,
  type WorkflowTaskState,
} from '@logger/TaskState';

// Local imports - shared
import type { OutputFileInfo, StreamTabId } from '@shared/schemas';

export interface WorkflowDiffRequest {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles: string[];
  outputFilesActive: boolean;
  streamId: StreamTabId;
  runId?: string;
  outputsByRound?: Record<string, OutputFileInfo[]>;
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

export interface ProgressWorkflowActionsState {
  getTaskState(stream: StreamTabId): TaskState | undefined;
  getExecutionId(stream: StreamTabId): string | undefined;
  getOutputFiles(stream: StreamTabId): Map<number, OutputFileInfo[]>;
  getKnownWorkspaceOutputPaths(stream: StreamTabId): Set<string>;
}

export interface ProgressWorkflowActionsControllerDeps {
  state: ProgressWorkflowActionsState;
  executeAgent(request: ExecutionRequest): Promise<void>;
  runDiff(request: WorkflowDiffRequest): Promise<void>;
  runFileOperation(
    operation: WorkflowFileOperation,
    request: WorkflowFileOperationRequest,
  ): Promise<void>;
}

export class ProgressWorkflowActionsController {
  constructor(private readonly deps: ProgressWorkflowActionsControllerDeps) {}

  async resume(stream: StreamTabId): Promise<void> {
    const taskState = this.deps.state.getTaskState(stream);
    if (!taskState) return;

    const executionId = isWorkflowTaskState(taskState)
      ? this.deps.state.getExecutionId(stream)
      : undefined;

    await this.deps.executeAgent({
      config: taskState.agentConfig,
      ...(executionId && { executionId }),
    });
  }

  async runNew(stream: StreamTabId): Promise<void> {
    const taskState = this.deps.state.getTaskState(stream);
    if (!taskState) return;

    await this.deps.executeAgent({ config: taskState.agentConfig });
  }

  async diffStream(stream: StreamTabId): Promise<void> {
    await this.withWorkflowTaskState(stream, async (taskState) => {
      const runOutputs = this.deps.state.getOutputFiles(stream);
      const outputsByRound = runOutputs.size
        ? Object.fromEntries(runOutputs.entries())
        : undefined;

      await this.deps.runDiff({
        agent: taskState.agentConfig.agent,
        model: taskState.agentConfig.model,
        inputFile: taskState.agentConfig.inputFile,
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
        inputFile: taskState.agentConfig.inputFile,
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
