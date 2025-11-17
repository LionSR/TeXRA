// Local imports - agent
import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import { AgentSetting, AgentPrompt } from '@agent/core/AgentDataclass';
import type {
  PipelineAgentSetting,
  PipelineStepConfig,
  PipelineStepOutput,
  PipelineContext,
} from '@agent/core/PipelineTypes';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { IAgent } from '@agent/core/IAgent';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';

// Local file imports
import { BaseReflectionAgent } from './BaseReflectionAgent';

/**
 * Pipeline agent implementation that orchestrates multiple agents sequentially.
 * Each step in the pipeline executes a complete agent, passing outputs between steps
 * according to the configured chainOutputToInput mode.
 */
export class PipelineAgent extends BaseReflectionAgent {
  private readonly pipelineSettings: PipelineAgentSetting;
  private readonly globalChainMode: boolean;
  private readonly originalInput: string;
  private readonly outputHistory: PipelineStepOutput[] = [];

  constructor(
    modelHandler: IModelHandler,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    context: AgentExecutionContext,
  ) {
    super(
      modelHandler,
      agentConfig,
      agentSetting,
      agentPrompt,
      agentPath,
      context,
    );

    // Type guard - ensure we have pipeline settings
    if (agentSetting.agentType !== 'pipeline') {
      throw new Error('PipelineAgent requires pipeline agent type');
    }

    this.pipelineSettings = agentSetting as PipelineAgentSetting;
    this.globalChainMode = this.pipelineSettings.chainOutputToInput;
    this.originalInput = agentConfig.inputFile;
  }

  /**
   * Override getTotalRounds to return number of pipeline steps.
   * This allows BaseReflectionAgent infrastructure to treat steps as rounds.
   */
  protected override getTotalRounds(): number {
    return this.pipelineSettings.pipeline.length;
  }

  /**
   * Generate output file name for pipeline agent itself.
   * Note: Individual step agents generate their own output filenames.
   */
  protected getOutputFile(currRound: number): string {
    // For pipeline agent, we don't generate our own output files
    // Each step agent generates its own outputs
    // This method is called by BaseReflectionAgent constructor
    return '';
  }

  /**
   * Main execution method for pipeline agent.
   * Executes each step sequentially, managing input/output flow between steps.
   */
  public override async run(): Promise<void> {
    this.logger.info('Starting pipeline execution');

    let currentInput = this.originalInput;

    try {
      for (let stepIndex = 0; stepIndex < this.pipelineSettings.pipeline.length; stepIndex++) {
        const step = this.pipelineSettings.pipeline[stepIndex];
        const useChainMode = step.chainOutputToInput ?? this.globalChainMode;

        this.logger.info(
          `Executing pipeline step ${stepIndex + 1}/${this.pipelineSettings.pipeline.length}: ${step.agent}`
        );

        // Log separator for UI
        this.logPipelineStepSeparator(stepIndex + 1, step.agent);

        // Build configuration for this step
        const stepConfig = this.buildStepConfig(
          step,
          currentInput,
          useChainMode,
          stepIndex,
        );

        // Create and execute step agent
        const stepAgent = await this.createAndInitStepAgent(stepConfig, stepIndex);
        await stepAgent.run();

        // Get the final output from the step
        const finalOutput = await this.getStepFinalOutput(stepAgent, stepIndex);

        if (!finalOutput) {
          throw new Error(`Step ${stepIndex + 1} (${step.agent}) produced no output`);
        }

        // Record output
        this.outputHistory.push({
          stepIndex: stepIndex + 1,  // 1-indexed
          agentName: step.agent,
          outputFile: finalOutput,
        });

        this.logger.info(
          `Completed step ${stepIndex + 1}: ${step.agent} → ${finalOutput}`
        );

        // Update input for next step if in chain mode
        if (useChainMode) {
          currentInput = finalOutput;
        }
      }

      this.logger.info('Pipeline execution completed successfully');
    } catch (error) {
      this.logger.error(`Pipeline execution failed: ${toErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Log a visual separator for pipeline steps in the UI.
   */
  private logPipelineStepSeparator(stepNumber: number, agentName: string): void {
    const separator = '─'.repeat(80);
    this.logger.info(`\n${separator}`);
    this.logger.info(`Pipeline Step ${stepNumber} / ${this.pipelineSettings.pipeline.length}: ${agentName}`);
    this.logger.info(`${separator}\n`);
  }

  /**
   * Build AgentConfig for a specific pipeline step.
   */
  private buildStepConfig(
    step: PipelineStepConfig,
    currentInput: string,
    chainMode: boolean,
    stepIndex: number,
  ): AgentConfig {
    const baseConfig: AgentConfig = {
      model: step.model ?? this.agentConfig.model,
      agent: step.agent,
      instruction: step.instruction ?? this.agentConfig.instruction,
      toolConfig: this.agentConfig.toolConfig,
      inputFile: '',
      inputFiles: [],
      referenceFile: null,
      referenceFiles: [],
      auxiliaryFile: this.agentConfig.auxiliaryFile,
      auxiliaryFiles: this.agentConfig.auxiliaryFiles,
      mediaFile: this.agentConfig.mediaFile,
      mediaFiles: this.agentConfig.mediaFiles,
      outputFiles: this.agentConfig.outputFiles,
      editedFile: this.agentConfig.editedFile,
      useMultipleOutputs: this.agentConfig.useMultipleOutputs,
      session: this.agentConfig.session,
    };

    if (chainMode) {
      // Mode A: Sequential transformation
      baseConfig.inputFile = currentInput;  // Previous output or original
    } else {
      // Mode B: Accumulating context
      baseConfig.inputFile = this.originalInput;  // Always original

      if (stepIndex > 0) {
        // Add previous outputs as references
        baseConfig.referenceFiles = this.outputHistory.map(o => o.outputFile);
      }
    }

    return baseConfig;
  }

  /**
   * Create and initialize a step agent with pipeline context.
   */
  private async createAndInitStepAgent(
    config: AgentConfig,
    stepIndex: number,
  ): Promise<IAgent> {
    // Import here to avoid circular dependency
    const { prepareAgentInstance } = await import('@agent/runtime/executeAgent');

    // Build pipeline context for this step
    const pipelineContext: PipelineContext = {
      currentStep: stepIndex + 1,
      totalSteps: this.pipelineSettings.pipeline.length,
      currentAgent: this.pipelineSettings.pipeline[stepIndex].agent,
      previousAgent: stepIndex > 0 ? this.pipelineSettings.pipeline[stepIndex - 1].agent : undefined,
      outputs: this.outputHistory,
      originalInput: this.originalInput,
      chainMode: this.pipelineSettings.pipeline[stepIndex].chainOutputToInput ?? this.globalChainMode,
    };

    // Prepare and return the agent instance with pipeline context
    const { agent } = await prepareAgentInstance({
      agentName: config.agent,
      configPayload: config,
      executionId: this.context.executionId,
      pipelineContext,
    });

    return agent;
  }

  /**
   * Extract the final output file from a completed step agent.
   */
  private async getStepFinalOutput(
    stepAgent: IAgent,
    stepIndex: number,
  ): Promise<string | null> {
    // Access the agent's output artifacts
    if ('roundOutputArtifacts' in stepAgent && Array.isArray((stepAgent as any).roundOutputArtifacts)) {
      const artifacts = (stepAgent as any).roundOutputArtifacts;

      // Get the last round's artifacts
      const lastRoundArtifacts = artifacts[artifacts.length - 1];

      if (lastRoundArtifacts && lastRoundArtifacts.fileMapping) {
        // Return the first output file (for single output agents)
        // For multiple output agents, we might need to handle differently
        const outputFiles = Object.keys(lastRoundArtifacts.fileMapping);
        if (outputFiles.length > 0) {
          return lastRoundArtifacts.fileMapping[outputFiles[0]].targetPath;
        }
      }
    }

    this.logger.warn(`Could not extract final output from step ${stepIndex + 1}`);
    return null;
  }

  /**
   * Override handleOutput - not used by pipeline agent
   */
  protected async handleOutput(): Promise<string[]> {
    // Pipeline agent doesn't handle its own output
    // Each step agent handles its own output
    return [];
  }
}
