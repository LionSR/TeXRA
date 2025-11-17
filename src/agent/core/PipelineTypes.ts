// Third-party imports
import { z } from 'zod';

// Local imports
import { AgentWorkflowSettingSchema } from './AgentDataclass';

/**
 * Configuration for a single step in a pipeline.
 */
export const PipelineStepConfigSchema = z.strictObject({
  agent: z.string().min(1, 'Agent name cannot be empty'),
  instruction: z.string().optional(),
  chainOutputToInput: z.boolean().optional(),
  model: z.string().optional(),
});

export type PipelineStepConfig = z.infer<typeof PipelineStepConfigSchema>;

/**
 * Settings for pipeline agents.
 * Extends workflow settings with pipeline-specific configuration.
 */
export const PipelineAgentSettingSchema = AgentWorkflowSettingSchema.extend({
  agentType: z.literal('pipeline'),
  chainOutputToInput: z.boolean(),
  pipeline: z.array(PipelineStepConfigSchema).min(1, 'Pipeline must have at least one step'),
});

export type PipelineAgentSetting = z.infer<typeof PipelineAgentSettingSchema>;

/**
 * Output information for a single pipeline step.
 */
export interface PipelineStepOutput {
  stepIndex: number;      // 1-indexed
  agentName: string;      // "derive", "criticize", etc.
  outputFile: string;     // Final output file from this step (e.g., "paper_derive_r1_model.tex")
}

/**
 * Context passed to child agents during pipeline execution.
 * Contains information about the current pipeline state.
 */
export interface PipelineContext {
  currentStep: number;           // 1-indexed (1, 2, 3, ...)
  totalSteps: number;
  currentAgent: string;          // Name of current step's agent
  previousAgent?: string;        // Name of previous step's agent (if step > 1)
  outputs: PipelineStepOutput[]; // All previous step outputs
  originalInput: string;         // Original input file path
  chainMode: boolean;            // For this specific step
}
