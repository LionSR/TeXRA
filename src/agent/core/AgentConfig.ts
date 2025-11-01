// Third-party imports
import { z } from 'zod';

// Local imports - agent
// Local imports - agent components
import {
  AgentCategory,
  AgentType,
  type AgentSessionDescriptor,
  resolveAgentSessionDescriptor,
} from './AgentDataclass';
import { DEFAULT_TOOL_CONFIG, ToolConfigSchema } from './ToolConfig';

/**
 * Checks that the number of output files does not exceed the number of input files.
 * Extracted as a separate function for clarity and reusability.
 */
export const validateOutputFiles = (cfg: Record<string, any>): boolean => {
  if (cfg.outputFiles) {
    const inputs = [cfg.inputFile, ...(cfg.inputFiles || [])];
    return cfg.outputFiles.length <= inputs.length;
  }
  return true;
};

/**
 * Session descriptor schema for AgentConfig.
 * The session field is the canonical source of truth for agent classification.
 */
const SessionDescriptorSchema = z.object({
  agentType: z.enum(AgentType).optional(),
  agentCategory: z.enum(AgentCategory),
});

/** Zod schema for validating AgentConfig objects */
const AgentConfigBaseSchema = z.object({
    model: z.string().prefault('gemini25p'),
    agent: z.string().prefault('correct'),
    instruction: z.string().prefault(''),
    useMultipleOutputs: z.boolean().prefault(false),

    // Legacy field for backward compatibility - prefer session.agentType
    agentType: z.enum(AgentType).optional(),
    // Canonical session descriptor - single source of truth
    session: SessionDescriptorSchema.optional(),

    inputFile: z.string().prefault(''),
    inputFiles: z.array(z.string()).nullable().prefault(null),
    referenceFile: z.string().nullable().prefault(null),
    referenceFiles: z.array(z.string()).nullable().prefault(null),
    auxiliaryFile: z.string().nullable().prefault(null),
    auxiliaryFiles: z.array(z.string()).nullable().prefault(null),
    mediaFile: z.string().nullable().prefault(null),
    mediaFiles: z.array(z.string()).nullable().prefault(null),
    outputFiles: z.array(z.string()).nullable().prefault(null),
    editedFile: z.string().nullable().prefault(null),

    toolConfig: ToolConfigSchema.prefault(DEFAULT_TOOL_CONFIG),
  })
  .refine(validateOutputFiles, {
    path: ['outputFiles'],
    error:
      'Number of output files must not be greater than the number of input files.',
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

/**
 * Parse arbitrary input into a canonical {@link AgentConfig} instance.
 */
export function parseAgentConfig(input: unknown): AgentConfig {
  const parsed = AgentConfigSchema.parse(input);
  return parsed;
}
