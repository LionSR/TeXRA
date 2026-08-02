// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type {
  OutputFileInfo,
  RoundIndexed,
  StreamTabId,
} from '@shared/schemas';
import { unique } from '@utils/core';

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
  getRunConfig(stream: StreamTabId): AgentConfig | undefined;
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
    await this.withWorkflowConfig(stream, async (config) => {
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
        agent: config.agent,
        model: config.model,
        inputFile: config.inputFiles[0] ?? '',
        outputFiles: config.outputFiles,
        outputFilesActive: config.outputFiles.length > 0,
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
    await this.withWorkflowConfig(stream, async (config) => {
      const outputFiles = this.resolveOutputFiles(stream, config);
      const executionId = this.deps.state.getExecutionId(stream);

      await this.deps.runFileOperation(operation, {
        streamId: stream,
        agent: config.agent,
        model: config.model,
        inputFile: config.inputFiles[0] ?? '',
        outputFiles,
        ...(executionId && { executionId }),
        skipProgressViewClear: true,
      });
    });
  }

  private async withWorkflowConfig(
    stream: StreamTabId,
    action: (config: AgentConfig) => Promise<void>,
  ): Promise<void> {
    const config = this.deps.state.getRunConfig(stream);
    if (!config || config.agentCategory !== AgentCategory.Workflow) return;

    await action(config);
  }

  private resolveOutputFiles(
    stream: StreamTabId,
    config: AgentConfig,
  ): string[] {
    const generatedPaths = this.deps.state.getKnownWorkspaceOutputPaths(stream);
    return unique([...config.outputFiles, ...generatedPaths].filter(Boolean));
  }
}
