// Third-party imports
import { z } from 'zod';

// Local imports - agent components
import { AgentType, resolveAgentSessionDescriptor } from './AgentDataclass';
import { AgentSessionDescriptorSchema } from './AgentSessionSchema';
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
 * File path fields shared across agent config, proposals, and messages.
 * Use .partial() for optional message fields, .extend() for defaults.
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
 * Core workflow fields shared between AgentConfig and WorkflowAgentProposal.
 * No defaults - consumers add their own via .extend() or .prefault().
 */
export const CoreWorkflowFieldsSchema = z.object({
  agent: z.string().describe('Name of the workflow agent to execute'),
  model: z.string().describe('Model to use for agent execution'),
  instruction: z.string().describe('Instruction for the workflow agent'),
  ...FileFieldsSchema.shape,
  useMultipleOutputs: z
    .boolean()
    .describe('Enable multiple outputs mode for agents that support it'),
});
export type CoreWorkflowFields = z.infer<typeof CoreWorkflowFieldsSchema>;

/** Zod schema for validating AgentConfig objects */
const stringArrayField = () => z.array(z.string()).prefault([]);

const AgentConfigBaseSchema = z
  .object({
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
    // Legacy field for backward compatibility - prefer session.agentType
    agentType: z.enum(AgentType).optional(),
    // Canonical session descriptor - single source of truth
    session: AgentSessionDescriptorSchema.optional(),
    editedFile: z.string().nullable().prefault(null),
    editedFiles: stringArrayField(),

    // Defaults to all-false for tool-use agents; workflow agents populate from UI
    toolConfig: ToolConfigSchema.prefault(DEFAULT_TOOL_CONFIG),
  })
  .superRefine((config, ctx) => {
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
  });

export const AgentConfigSchema = AgentConfigBaseSchema.transform((config) => {
  const descriptor = resolveAgentSessionDescriptor(
    config.session?.agentType ?? config.agentType,
    config.session?.agentCategory,
  );

  return {
    ...config,
    agentType: descriptor.agentType,
    session: descriptor,
  };
});

export type AgentConfig = z.output<typeof AgentConfigSchema>;
export type AgentConfigInput = z.input<typeof AgentConfigSchema>;
