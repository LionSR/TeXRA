// Local imports - agent
import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import type { ExecutionRequest } from '@agent/core/executionRequests';

// Local imports - logger
import {
  isWorkflowTaskState,
  type TaskState,
  type WorkflowTaskState,
} from '@logger/TaskState';

// Local imports - shared
import type {
  CompileFailure,
  OutputFileInfo,
  StreamTabId,
} from '@shared/schemas';

export interface ProgressFollowUpModelOption {
  value: string;
  disabled?: boolean;
}

export interface ProgressFollowUpWorkspace {
  locatePath(path: string):
    | { kind: 'workspace'; relativePath: string }
    | {
        kind: 'external';
      };
  exists(relativePath: string): Promise<boolean>;
}

export interface ProgressFollowUpControllerDeps {
  getAgentCategory(agent: string): AgentCategory | undefined;
  workspace: ProgressFollowUpWorkspace;
}

export type ProgressFollowUpPlan =
  | { kind: 'warning'; message: string }
  | { kind: 'info'; message: string }
  | {
      kind: 'restoreState';
      taskState: TaskState;
      executeImmediately: boolean;
    }
  | { kind: 'execute'; request: ExecutionRequest };

export interface ToolUseFollowUpInput {
  streamId: StreamTabId;
  taskState: TaskState | undefined;
  outputFiles: OutputFileInfo[];
  agent: string;
  model: string;
  initialQuestion?: string;
  executeImmediately: boolean;
  modelOptions: readonly ProgressFollowUpModelOption[];
  executionId?: string;
}

export interface CompileFixerInput {
  streamId: StreamTabId;
  taskState: TaskState | undefined;
  compileFailures: CompileFailure[];
  runOutputs: Map<number, OutputFileInfo[]>;
  modelOptions: readonly ProgressFollowUpModelOption[];
  executionId?: string;
}

export class ProgressFollowUpController {
  constructor(private readonly deps: ProgressFollowUpControllerDeps) {}

  planToolUseFollowUp(input: ToolUseFollowUpInput): ProgressFollowUpPlan {
    if (!input.taskState || !isWorkflowTaskState(input.taskState)) {
      return {
        kind: 'warning',
        message:
          'No workflow state found for this stream. Cannot set up a follow-up.',
      };
    }

    if (input.outputFiles.length === 0) {
      return {
        kind: 'info',
        message: 'No workflow output files are available for a follow-up yet.',
      };
    }

    if (this.deps.getAgentCategory(input.agent) !== AgentCategory.ToolUse) {
      return {
        kind: 'warning',
        message: 'Select a tool-use agent before starting a follow-up.',
      };
    }

    if (!this.hasEnabledModel(input.modelOptions, input.model)) {
      return {
        kind: 'warning',
        message: 'Select an available model before starting a follow-up.',
      };
    }

    const agentConfig = AgentConfigSchema.parse({
      ...input.taskState.agentConfig,
      agent: input.agent,
      model: input.model,
      agentCategory: AgentCategory.ToolUse,
      instruction: this.buildWorkflowToolUseFollowupInstruction(
        input.outputFiles,
        input.initialQuestion,
        input.executionId,
      ),
      outputFiles: [],
      editedFile: null,
      editedFiles: [],
    }) as AgentConfig & { agentCategory: typeof AgentCategory.ToolUse };

    return {
      kind: 'restoreState',
      taskState: { agentConfig },
      executeImmediately: input.executeImmediately,
    };
  }

  async planCompileFixer(
    input: CompileFixerInput,
  ): Promise<ProgressFollowUpPlan> {
    if (!input.taskState || !isWorkflowTaskState(input.taskState)) {
      return {
        kind: 'warning',
        message:
          'No workflow state found for this stream. Cannot run latexFixer.',
      };
    }

    if (input.compileFailures.length === 0) {
      return {
        kind: 'info',
        message: 'No compile failures are recorded for this stream.',
      };
    }

    const model = this.resolveWorkflowModel(
      input.taskState,
      input.modelOptions,
    );
    if (!model) {
      return {
        kind: 'warning',
        message: 'No model is available to launch latexFixer.',
      };
    }

    const editableFiles = await this.resolveCompileFixerInputFiles(
      input.taskState.agentConfig,
      input.compileFailures,
      input.runOutputs,
    );
    if (editableFiles.length === 0) {
      return {
        kind: 'warning',
        message:
          'No editable workspace source file matched the compile failure. Accept the output into the workspace first, then run latexFixer.',
      };
    }

    return {
      kind: 'execute',
      request: {
        config: this.buildCompileFixerConfig(
          input.taskState.agentConfig,
          model,
          editableFiles,
          this.buildCompileFixerQuestion(
            input.compileFailures,
            editableFiles,
            input.executionId,
          ),
        ),
      },
    };
  }

  private hasEnabledModel(
    modelOptions: readonly ProgressFollowUpModelOption[],
    model: string,
  ): boolean {
    return modelOptions.some((option) => {
      return option.value === model && !option.disabled;
    });
  }

  private resolveWorkflowModel(
    taskState: WorkflowTaskState,
    modelOptions: readonly ProgressFollowUpModelOption[],
  ): string | null {
    const workflowModel = taskState.agentConfig.model;
    if (this.hasEnabledModel(modelOptions, workflowModel)) {
      return workflowModel;
    }
    return modelOptions.find((option) => !option.disabled)?.value ?? null;
  }

  private buildWorkflowToolUseFollowupInstruction(
    outputFiles: OutputFileInfo[],
    initialQuestion: string | undefined,
    executionId: string | undefined,
  ): string {
    const executionHint = executionId ? `Execution: ${executionId}` : undefined;
    const userQuestion = initialQuestion?.trim();
    const outputLines = outputFiles.map((output) => {
      const outputPath = this.formatOutputReferencePath(output, executionId);
      const source = output.source ? ` (source: ${output.source})` : '';
      return `- r${output.round}: ${outputPath}${source}`;
    });

    return [
      'Continue from the completed workflow run. The workflow wrote generated files to task-run storage, so use the output paths below as read-only context unless a path is explicitly in the workspace.',
      executionHint,
      'Workflow outputs:',
      ...outputLines,
      userQuestion ? `User follow-up request: ${userQuestion}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildCompileFixerQuestion(
    compileFailures: CompileFailure[],
    editableFiles: string[],
    executionId: string | undefined,
  ): string {
    const executionHint = executionId ? `Execution: ${executionId}` : undefined;
    const editableHint =
      editableFiles.length > 0
        ? `Editable workspace target${editableFiles.length === 1 ? '' : 's'}: ${editableFiles.join(', ')}`
        : undefined;
    const failureLines = compileFailures.map((failure) => {
      const outputPath =
        executionId && failure.output.kind === 'runStorage'
          ? `/executions/${executionId}/files/${failure.output.relativePath}`
          : failure.output.kind === 'external'
            ? failure.output.absolutePath
            : failure.output.relativePath;
      const logPath = executionId
        ? `/executions/${executionId}/files/${failure.logRelativePath}`
        : failure.log.absolutePath;
      return `- r${failure.round} ${failure.displayName}: output ${outputPath}; compile log ${logPath}`;
    });

    return [
      'The workflow compile check failed. Diagnose and fix the generated LaTeX output using the compile log context below.',
      executionHint,
      editableHint,
      ...failureLines,
      'Use read_file/edit_file on the editable workspace target files. Use /executions paths only to inspect the generated output and logs.',
      'If the failure is caused by a missing external dependency rather than editable LaTeX, report that clearly instead of inventing the missing file.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildCompileFixerConfig(
    originalConfig: AgentConfig,
    model: string,
    editableFiles: string[],
    instruction: string,
  ): AgentConfig {
    return {
      ...originalConfig,
      agent: 'latexFixer',
      model,
      instruction,
      agentCategory: AgentCategory.ToolUse,
      inputFiles: editableFiles,
      outputFiles: [],
      editedFile: null,
      editedFiles: [],
    };
  }

  private async resolveCompileFixerInputFiles(
    originalConfig: AgentConfig,
    compileFailures: CompileFailure[],
    runOutputs: Map<number, OutputFileInfo[]>,
  ): Promise<string[]> {
    const preferred = this.compileFixerInputCandidates(
      originalConfig,
      compileFailures,
      runOutputs,
    );
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const candidate of preferred) {
      const location = this.deps.workspace.locatePath(candidate);
      if (location.kind === 'external') continue;
      if (seen.has(location.relativePath)) continue;
      if (!(await this.deps.workspace.exists(location.relativePath))) continue;
      seen.add(location.relativePath);
      targets.push(location.relativePath);
    }
    return targets;
  }

  /**
   * Prefer the source recorded for the failed generated output. Original
   * workflow inputs are recovery candidates for older runs or incomplete output
   * metadata, not a second owner of the compile failure.
   */
  private compileFixerInputCandidates(
    originalConfig: AgentConfig,
    compileFailures: CompileFailure[],
    runOutputs: Map<number, OutputFileInfo[]>,
  ): string[] {
    const outputByPath = new Map<string, OutputFileInfo>();
    for (const output of [...runOutputs.values()].flat()) {
      outputByPath.set(output.location.absolutePath, output);
    }

    const generatedOutputSources = compileFailures
      .map((failure) => outputByPath.get(failure.output.absolutePath)?.source)
      .filter((source): source is string => !!source);
    const originalInputRecovery = originalConfig.inputFiles.filter(Boolean);

    return [...generatedOutputSources, ...originalInputRecovery];
  }

  private formatOutputReferencePath(
    output: OutputFileInfo,
    executionId: string | undefined,
  ): string {
    const location = output.location;
    switch (location.kind) {
      case 'runStorage':
        return `/executions/${executionId ?? location.executionId}/files/${location.relativePath}`;
      case 'workspace':
        return location.relativePath;
      case 'external':
        return location.absolutePath;
    }
  }
}
