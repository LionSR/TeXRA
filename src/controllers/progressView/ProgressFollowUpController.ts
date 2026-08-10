// Local imports
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  ToolUseAgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { ExecutionRequest } from '@agent/core/state/executionRequests';
import { detectGeneratedLatexdiffArtifact } from '@latex/latexdiff/diffFileNameManager';
import { decideRunModel } from '@model/runModelDecision';
import type {
  CompileFailure,
  FileLocation,
  OutputFileInfo,
  RoundIndexed,
  StreamTabId,
} from '@shared/schemas';
import type { RunMetadata } from '@transcript/StreamSnapshotStore';
import { pluralize } from '@utils/text/stringUtils';

export interface ProgressFollowUpModelOption {
  value: string;
  disabled?: boolean;
}

interface ProgressFollowUpWorkspace {
  locatePath(path: string):
    | { kind: 'workspace'; relativePath: string }
    | {
        kind: 'external';
      };
  exists(relativePath: string): Promise<boolean>;
}

export interface ProgressFollowUpControllerDeps {
  getAgentCategory(agent: string): AgentCategory | undefined;
  loadModelOptions(): Promise<readonly ProgressFollowUpModelOption[]>;
  state: ProgressFollowUpState;
  workspace: ProgressFollowUpWorkspace;
}

export interface ProgressFollowUpState {
  getRunMetadata(stream: StreamTabId): RunMetadata;
  getOutputFiles(stream: StreamTabId): RoundIndexed<OutputFileInfo>;
  getCompileFailures(stream: StreamTabId): RoundIndexed<CompileFailure>;
}

interface CompileFixerTarget {
  path: string;
  latexdiffArtifact?: {
    sourcePath: string;
    sourceExists: boolean;
  };
  missingLatexdiffArtifact?: string;
}

export type ProgressFollowUpPlan =
  | { kind: 'warning'; message: string }
  | { kind: 'info'; message: string }
  | {
      kind: 'restoreState';
      config: AgentConfig;
      executeImmediately: boolean;
    }
  // Produced only by planCompileFixer (latexFixer). The progress view opts every
  // 'execute' plan into the helper-model preference, so a new 'execute'-plan
  // producer would inherit it (gate the swap more narrowly if that isn't wanted).
  | { kind: 'execute'; request: ExecutionRequest };

export interface ToolUseFollowUpInput {
  streamId: StreamTabId;
  runConfig: AgentConfig | undefined;
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
  runConfig: AgentConfig | undefined;
  compileFailures: CompileFailure[];
  runOutputs: RoundIndexed<OutputFileInfo>;
  modelOptions: readonly ProgressFollowUpModelOption[];
  executionId?: string;
}

export type StreamToolUseFollowUpInput = Omit<
  ToolUseFollowUpInput,
  'runConfig' | 'outputFiles' | 'modelOptions' | 'executionId'
>;

/** Both follow-up planners are workflow-only; tool-use runs have no plan. */
function asWorkflowConfig(
  config: AgentConfig | undefined,
): AgentConfig | undefined {
  return config?.agentCategory === AgentCategory.Workflow ? config : undefined;
}

export class ProgressFollowUpController {
  constructor(private readonly deps: ProgressFollowUpControllerDeps) {}

  async planToolUseFollowUpForStream(
    input: StreamToolUseFollowUpInput,
  ): Promise<ProgressFollowUpPlan> {
    const modelOptions = await this.deps.loadModelOptions();
    const outputFiles = Object.values(
      this.deps.state.getOutputFiles(input.streamId),
    ).flat();
    const { config: runConfig, executionId } = this.deps.state.getRunMetadata(
      input.streamId,
    );

    return this.planToolUseFollowUp({
      ...input,
      runConfig,
      outputFiles,
      modelOptions,
      executionId,
    });
  }

  async planCompileFixerForStream(
    streamId: StreamTabId,
  ): Promise<ProgressFollowUpPlan> {
    const modelOptions = await this.deps.loadModelOptions();
    const compileFailures = Object.values(
      this.deps.state.getCompileFailures(streamId),
    ).flat();
    const { config: runConfig, executionId } =
      this.deps.state.getRunMetadata(streamId);

    return this.planCompileFixer({
      streamId,
      runConfig,
      compileFailures,
      runOutputs: this.deps.state.getOutputFiles(streamId),
      modelOptions,
      executionId,
    });
  }

  planToolUseFollowUp(input: ToolUseFollowUpInput): ProgressFollowUpPlan {
    const workflowConfig = asWorkflowConfig(input.runConfig);
    if (!workflowConfig) {
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

    const agentConfig = ToolUseAgentConfigSchema.parse({
      ...workflowConfig,
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
    });

    return {
      kind: 'restoreState',
      config: agentConfig,
      executeImmediately: input.executeImmediately,
    };
  }

  async planCompileFixer(
    input: CompileFixerInput,
  ): Promise<ProgressFollowUpPlan> {
    const workflowConfig = asWorkflowConfig(input.runConfig);
    if (!workflowConfig) {
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

    const model = this.selectWorkflowModel(workflowConfig, input.modelOptions);
    if (!model) {
      return {
        kind: 'warning',
        message: 'No model is available to launch latexFixer.',
      };
    }

    const targets = await this.compileFixerTargets(
      workflowConfig,
      input.compileFailures,
      input.runOutputs,
    );
    if (targets.length === 0) {
      return {
        kind: 'warning',
        message:
          'No editable workspace file matched the compile failure. Accept the output into the workspace first, then run latexFixer.',
      };
    }

    const editableFiles = targets.map((target) => target.path);
    return {
      kind: 'execute',
      request: {
        config: this.buildCompileFixerConfig(
          workflowConfig,
          model,
          editableFiles,
          this.buildCompileFixerQuestion(
            input.compileFailures,
            targets,
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
    return modelOptions.some(
      (option) => option.value === model && !option.disabled,
    );
  }

  private selectWorkflowModel(
    workflowConfig: AgentConfig,
    modelOptions: readonly ProgressFollowUpModelOption[],
  ): string | null {
    const decision = decideRunModel(
      [
        {
          model: workflowConfig.model,
          reason: 'agent-config',
          fallbackMode: 'silent',
        },
        {
          model: modelOptions.find((option) => !option.disabled)?.value,
          reason: 'access-list-default',
        },
      ],
      (model) => this.hasEnabledModel(modelOptions, model),
    );
    if (!decision || decision.unavailable) return null;
    return decision.model;
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
    targets: CompileFixerTarget[],
    executionId: string | undefined,
  ): string {
    const executionHint = executionId ? `Execution: ${executionId}` : undefined;
    const editableFiles = targets.map((target) => target.path);
    const editableHint = `Editable workspace ${pluralize(editableFiles.length, 'target')}: ${editableFiles.join(', ')}`;
    const latexdiffContext = this.formatLatexdiffTargetContext(targets);
    const failureLines = compileFailures.map((failure) => {
      const outputPath = this.formatCompileFailureOutputPath(
        failure.output,
        executionId,
      );
      const logPath = executionId
        ? runStorageFilePath(executionId, failure.logRelativePath)
        : failure.log.absolutePath;
      return `- r${failure.round} ${failure.displayName}: output ${outputPath}; compile log ${logPath}`;
    });

    return [
      'The workflow compile check failed. Diagnose and fix the generated LaTeX output using the compile log context below.',
      executionHint,
      editableHint,
      latexdiffContext,
      ...failureLines,
      'Use read_file/edit_file on the editable workspace target files. Use /executions paths only to inspect the generated output and logs.',
      'If the failure is caused by a missing external dependency rather than editable LaTeX, report that clearly instead of inventing the missing file.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private formatLatexdiffTargetContext(
    targets: CompileFixerTarget[],
  ): string | undefined {
    const lines = targets.flatMap((target) => {
      if (target.missingLatexdiffArtifact) {
        return `- ${target.missingLatexdiffArtifact} was a latexdiff artifact candidate, but it is not present in the workspace. ${target.path} is the inferred source fallback.`;
      }
      const artifact = target.latexdiffArtifact;
      if (!artifact) return [];
      const sourceHint = artifact.sourceExists
        ? ` generated from ${artifact.sourcePath}`
        : `; inferred source ${artifact.sourcePath} is not present in the workspace`;
      const sourceFixHint = artifact.sourceExists
        ? ` If the error originates in the original source document, fix ${artifact.sourcePath} too so a regenerated diff stays fixed.`
        : '';
      return `- ${target.path} is a latexdiff artifact${sourceHint}. If the error comes from broken latexdiff markup (\\DIFadd/\\DIFdel or DIF preamble blocks), repair this artifact in place and keep diff annotations intact.${sourceFixHint}`;
    });
    return lines.length > 0
      ? ['Latexdiff context:', ...lines].join('\n')
      : undefined;
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

  private async compileFixerTargets(
    originalConfig: AgentConfig,
    compileFailures: CompileFailure[],
    runOutputs: RoundIndexed<OutputFileInfo>,
  ): Promise<CompileFixerTarget[]> {
    const preferred = this.compileFixerInputCandidates(
      originalConfig,
      compileFailures,
      runOutputs,
    );
    const targets: CompileFixerTarget[] = [];
    const targetByPath = new Map<string, CompileFixerTarget>();
    for (const candidate of preferred) {
      const location = this.deps.workspace.locatePath(candidate);
      if (location.kind === 'external') continue;
      const candidateTargets = await this.compileFixerTargetsForCandidate(
        location.relativePath,
      );
      for (const target of candidateTargets) {
        const existing = targetByPath.get(target.path);
        if (existing) {
          existing.latexdiffArtifact ??= target.latexdiffArtifact;
          existing.missingLatexdiffArtifact ??= target.missingLatexdiffArtifact;
          continue;
        }
        targetByPath.set(target.path, target);
        targets.push(target);
      }
    }
    return targets;
  }

  private async compileFixerTargetsForCandidate(
    relativePath: string,
  ): Promise<CompileFixerTarget[]> {
    const artifact = detectGeneratedLatexdiffArtifact(relativePath);
    if (!artifact) {
      return (await this.deps.workspace.exists(relativePath))
        ? [{ path: relativePath }]
        : [];
    }

    const sourcePath = artifact.sourcePath;
    const sourceExists = await this.deps.workspace.exists(sourcePath);
    const artifactExists = await this.deps.workspace.exists(relativePath);
    if (!artifactExists) {
      return sourceExists
        ? [{ path: sourcePath, missingLatexdiffArtifact: relativePath }]
        : [];
    }

    // A user may legitimately name a source file `chapter_diff.tex`. Treat the
    // weak workspace suffix as generated only when its inferred source exists.
    if (artifact.kind === 'workspaceDiff' && !sourceExists) {
      return [{ path: relativePath }];
    }

    const targets: CompileFixerTarget[] = [
      {
        path: relativePath,
        latexdiffArtifact: { sourcePath, sourceExists },
      },
    ];
    if (sourceExists) {
      targets.push({ path: sourcePath });
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
    runOutputs: RoundIndexed<OutputFileInfo>,
  ): string[] {
    const outputByPath = new Map<string, OutputFileInfo>();
    for (const output of Object.values(runOutputs).flat()) {
      outputByPath.set(output.location.absolutePath, output);
    }

    const generatedOutputSources = compileFailures
      .map((failure) => outputByPath.get(failure.output.absolutePath)?.source)
      .filter((source): source is string => !!source);
    const originalInputRecovery = originalConfig.inputFiles.filter(Boolean);

    return [...generatedOutputSources, ...originalInputRecovery];
  }

  private formatCompileFailureOutputPath(
    output: FileLocation,
    executionId: string | undefined,
  ): string {
    if (executionId && output.kind === 'runStorage') {
      return runStorageFilePath(executionId, output.relativePath);
    }
    if (output.kind === 'external') {
      return output.absolutePath;
    }
    return output.relativePath;
  }

  private formatOutputReferencePath(
    output: OutputFileInfo,
    executionId: string | undefined,
  ): string {
    const location = output.location;
    switch (location.kind) {
      case 'runStorage':
        return runStorageFilePath(
          executionId ?? location.executionId,
          location.relativePath,
        );
      case 'workspace':
        return location.relativePath;
      case 'external':
        return location.absolutePath;
    }
  }
}

/**
 * Reference to a run-storage file the way the follow-up prompt addresses it:
 * `/executions/<executionId>/files/<relativePath>`.
 */
function runStorageFilePath(executionId: string, relativePath: string): string {
  return `/executions/${executionId}/files/${relativePath}`;
}
