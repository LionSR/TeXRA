// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { createLog } from '@logger/logUtils';
import type {
  OutputFileInfo,
  ReadonlyRoundIndexed,
  RunId,
} from '@shared/schemas';
import { AgentCategory, cloneRoundIndexed } from '@shared/schemas';
import { unique } from '@utils/core';
import type { RunOutputsSource } from './runOutputs';

const log = createLog('ProgressWorkflowRunActions');

export interface WorkflowDiffRequest {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles: string[];
  outputFilesActive: boolean;
  runId: RunId;
  outputsByRound?: ReadonlyRoundIndexed<OutputFileInfo>;
}

export type WorkflowFileOperation = 'pack' | 'clean';

export interface WorkflowFileOperationRequest {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles: string[];
  runId: RunId;
}

interface ProgressWorkflowRunActionsState extends RunOutputsSource {
  getKnownWorkspaceOutputPaths(stream: RunId): Set<string>;
}

interface ProgressWorkflowRunActionsControllerDeps {
  state: ProgressWorkflowRunActionsState;
  runDiff(request: WorkflowDiffRequest): Promise<void>;
  runFileOperation(
    operation: WorkflowFileOperation,
    request: WorkflowFileOperationRequest,
  ): Promise<void>;
}

export class ProgressWorkflowRunActionsController {
  constructor(
    private readonly deps: ProgressWorkflowRunActionsControllerDeps,
  ) {}

  async diffStream(
    stream: RunId,
    config: AgentConfig | undefined,
  ): Promise<void> {
    await this.withWorkflowConfig(stream, config, async (config) => {
      // Round keys are canonical non-negative integers by construction
      // (`roundIndexedRecord` in `@shared/schemas/roundIndexed.ts`), so this record
      // already enumerates ascending per the ES2015+ integer-key spec rule;
      // runLatexdiffForRun consumes `outputsByRound` in that order
      // without needing an explicit sort here.
      // Frozen at click time. `getOutputFiles` returns the store's live
      // record, and this request crosses an interactive quick pick
      // (`promptForLatexdiffMathMarkup`, `ignoreFocusOut`) before
      // `handleRunLatexdiff` reads `outputsByRound`, so a run finishing a round
      // mid-prompt would otherwise widen the diff scope under the user.
      const runOutputs = this.deps.state.getOutputFiles(stream);
      const outputsByRound = Object.keys(runOutputs).length
        ? cloneRoundIndexed(runOutputs)
        : undefined;

      await this.deps.runDiff({
        agent: config.agent,
        model: config.model,
        inputFile: config.inputFiles[0] ?? '',
        outputFiles: config.outputFiles,
        outputFilesActive: config.outputFiles.length > 0,
        runId: stream,
        outputsByRound,
      });
    });
  }

  async runFileOperation(
    stream: RunId,
    operation: WorkflowFileOperation,
    config: AgentConfig | undefined,
  ): Promise<void> {
    await this.withWorkflowConfig(stream, config, async (config) => {
      const outputFiles = this.resolveOutputFiles(stream, config);

      await this.deps.runFileOperation(operation, {
        agent: config.agent,
        model: config.model,
        inputFile: config.inputFiles[0] ?? '',
        outputFiles,
        runId: stream,
      });
    });
  }

  private async withWorkflowConfig(
    stream: RunId,
    config: AgentConfig | undefined,
    action: (config: AgentConfig) => Promise<void>,
  ): Promise<void> {
    if (!config) {
      // This controller holds no messaging port, so the refusal is at least
      // recorded rather than dropped: the toolbar action does nothing.
      log.warn(
        `Workflow action skipped for stream ${stream}: the run has no persisted config.`,
      );
      return;
    }
    if (config.agentCategory !== AgentCategory.Workflow) return;

    await action(config);
  }

  private resolveOutputFiles(stream: RunId, config: AgentConfig): string[] {
    const generatedPaths = this.deps.state.getKnownWorkspaceOutputPaths(stream);
    return unique([...config.outputFiles, ...generatedPaths].filter(Boolean));
  }
}
