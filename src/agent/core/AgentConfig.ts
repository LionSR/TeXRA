// Third-party imports
import { z } from 'zod';

// Local imports - agent
// Local imports - agent components
import { AgentCategory, AgentType, type AgentSessionDescriptor } from './AgentDataclass';
import { AgentSessionDescriptorSchema } from './AgentSessionSchema';
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
/** Zod schema for validating AgentConfig objects */
export const AgentConfigSchema = z
  .object({
    model: z.string().prefault('gemini25p'),
    agent: z.string().prefault('correct'),
    instruction: z.string().prefault(''),
    useMultipleOutputs: z.boolean().prefault(false),

    // Legacy field for backward compatibility - prefer session.agentType
    agentType: z.enum(AgentType).optional(),
    // Canonical session descriptor - single source of truth
    session: AgentSessionDescriptorSchema.optional(),

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

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
