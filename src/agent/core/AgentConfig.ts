// Third-party imports
import { z } from 'zod';

// Local imports - agent components
import { AgentCategory } from './AgentDataclass';
import { DEFAULT_TOOL_CONFIG, ToolConfigSchema } from './ToolConfig';

/**
 * Checks that the number of output files does not exceed the number of input files.
 * Extracted as a separate function for clarity and reusability.
 */
export const validateOutputFiles = (cfg: {
  inputFile: string;
  inputFiles: string[];
  outputFiles: string[];
}): boolean => {
  if (cfg.outputFiles.length === 0) {
    return true;
  }

  const inputs = [cfg.inputFile, ...cfg.inputFiles];
  return cfg.outputFiles.length <= inputs.length;
};

/**
 * Base proposal fields shared by both workflow and tool-use agent proposals.
 * Contains only the common fields that all proposal types need.
 */
export const BaseProposalFieldsSchema = z.object({
  agent: z.string().describe('Name of the agent to execute'),
  model: z.string().describe('Model to use for agent execution'),
  instruction: z.string().describe('Instruction for the agent'),
});
export type BaseProposalFields = z.infer<typeof BaseProposalFieldsSchema>;

/**
 * File path fields for workflow agents only.
 * Tool-use agents access files through their own tools instead.
 */
export const FileFieldsSchema = z.object({
  inputFile: z.string().describe('Path to the primary input file'),
  inputFiles: z.array(z.string()).describe('Additional input file paths'),
  referenceFile: z
    .string()
    .nullable()
    .describe('Reference file path for additional context'),
  referenceFiles: z
    .array(z.string())
    .describe('Additional reference file paths'),
  auxiliaryFile: z
    .string()
    .nullable()
    .describe('Auxiliary file path for supplementary content'),
  auxiliaryFiles: z
    .array(z.string())
    .describe('Additional auxiliary file paths'),
  mediaFile: z
    .string()
    .nullable()
    .describe('Media file path for images/figures'),
  mediaFiles: z.array(z.string()).describe('Additional media file paths'),
  outputFiles: z.array(z.string()).describe('Desired output file paths'),
});
export type FileFields = z.infer<typeof FileFieldsSchema>;

/**
 * Workflow-specific fields: file fields + multiple outputs flag.
 * Only workflow agents (document processing) use these fields.
 */
export const WorkflowSpecificFieldsSchema = FileFieldsSchema.extend({
  useMultipleOutputs: z
    .boolean()
    .describe('Enable multiple outputs mode for agents that support it'),
});
export type WorkflowSpecificFields = z.infer<
  typeof WorkflowSpecificFieldsSchema
>;

/**
 * Core workflow fields - combines base fields with workflow-specific fields.
 * Used by AgentConfig and WorkflowAgentProposal (workflow category only).
 * No defaults - consumers add their own via .extend() or .prefault().
 */
export const CoreWorkflowFieldsSchema = BaseProposalFieldsSchema.extend({
  ...WorkflowSpecificFieldsSchema.shape,
});
export type CoreWorkflowFields = z.infer<typeof CoreWorkflowFieldsSchema>;

/** Zod schema for validating AgentConfig objects */
const stringArrayField = () => z.array(z.string()).prefault([]);

/**
 * Pure object schema without refinements.
 * Used for .partial() since Zod v4 doesn't allow .partial() on refined schemas.
 */
const AgentConfigFieldsSchema = z.object({
  // Core workflow fields with defaults
  agent: z.string().prefault('correct'),
  model: z.string().prefault('gemini3p'),
  instruction: z.string().prefault(''),
  useMultipleOutputs: z.boolean().prefault(false),
  inputFile: z.string().prefault(''),
  inputFiles: stringArrayField(),
  referenceFile: z.string().nullable().prefault(null),
  referenceFiles: stringArrayField(),
  auxiliaryFile: z.string().nullable().prefault(null),
  auxiliaryFiles: stringArrayField(),
  mediaFile: z.string().nullable().prefault(null),
  mediaFiles: stringArrayField(),
  outputFiles: stringArrayField(),

  // AgentConfig-specific fields
  agentCategory: z.nativeEnum(AgentCategory).prefault(AgentCategory.Workflow),
  editedFile: z.string().nullable().prefault(null),
  editedFiles: stringArrayField(),

  // Defaults to all-false for tool-use agents; workflow agents populate from UI
  toolConfig: ToolConfigSchema.prefault(DEFAULT_TOOL_CONFIG),
});

/**
 * Lift legacy session.agentCategory to top level for backward compatibility.
 * Persisted data may have { session: { agentCategory } } format.
 *
 * Exported for reuse in TaskState.ts to maintain single source of truth.
 */
export const liftLegacyAgentCategory = (input: unknown): unknown => {
  if (typeof input !== 'object' || input === null) return input;
  const obj = input as Record<string, unknown>;

  // If agentCategory already exists at top level, no migration needed
  if ('agentCategory' in obj && obj.agentCategory !== undefined) {
    return input;
  }

  // Lift from session.agentCategory if present (legacy format)
  // Note: The `session` field is left in place but is ignored by the schema.
  // AgentConfigFieldsSchema uses z.object() which strips unknown fields.
  const session = obj.session as Record<string, unknown> | undefined;
  if (session && typeof session === 'object' && 'agentCategory' in session) {
    return { ...obj, agentCategory: session.agentCategory };
  }

  return input;
};

/**
 * Agent configuration schema with output file count validation.
 * Includes backward compatibility for legacy { session: { agentCategory } } format.
 */
export const AgentConfigSchema = z.preprocess(
  liftLegacyAgentCategory,
  AgentConfigFieldsSchema.superRefine((config, ctx) => {
    if (
      !validateOutputFiles({
        inputFile: config.inputFile,
        inputFiles: config.inputFiles,
        outputFiles: config.outputFiles,
      })
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['outputFiles'],
        message:
          'Number of output files must not be greater than the number of input files.',
      });
    }
  }),
);

// Re-export AgentCategory for convenience
// Canonical source: AgentDataclass.ts
export { AgentCategory };

export type AgentConfig = z.output<typeof AgentConfigSchema>;
// Use AgentConfigFieldsSchema for input type since preprocess makes input `unknown`
export type AgentConfigInput = z.input<typeof AgentConfigFieldsSchema>;

/**
 * Schema for agent configuration payload passed to executeAgent.
 *
 * Only `agent` and `model` are required - all other fields have defaults.
 * This replaces ambiguous `Partial<AgentConfig>` usage with explicit requirements.
 *
 * Uses AgentConfigFieldsSchema (without refinement) since Zod v4 doesn't
 * allow .partial() on schemas with refinements. The output file count
 * validation is applied later when parsing with AgentConfigSchema.
 */
export const AgentConfigPayloadSchema = AgentConfigFieldsSchema.partial()
  .required({
    agent: true,
    model: true,
  })
  .describe('Agent configuration payload with required agent and model fields');

export type AgentConfigPayload = z.infer<typeof AgentConfigPayloadSchema>;
