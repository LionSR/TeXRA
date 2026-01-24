// Third-party imports
import { z } from 'zod';

// Local imports - agent components
import { AgentCategory, AgentCategorySchema } from './AgentDataclass';
import { DEFAULT_TOOL_CONFIG, ToolConfigSchema } from './ToolConfig';

// Re-export proposal schemas from shared (single source of truth)
export {
  BaseProposalFieldsSchema,
  WorkflowSpecificFieldsSchema,
} from '@shared/schemas/proposalFields';

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
  agentCategory: AgentCategorySchema.prefault(AgentCategory.Workflow),
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
export function liftLegacyAgentCategory(input: unknown): unknown {
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
  if (session && 'agentCategory' in session) {
    return { ...obj, agentCategory: session.agentCategory };
  }

  return input;
}

/**
 * Agent configuration schema with output file count validation.
 * Includes backward compatibility for legacy { session: { agentCategory } } format.
 */
export const AgentConfigSchema = z.preprocess(
  liftLegacyAgentCategory,
  AgentConfigFieldsSchema.superRefine((config, ctx) => {
    // Validate that output files count doesn't exceed input files count
    if (config.outputFiles.length > 0) {
      const inputCount = 1 + config.inputFiles.length; // inputFile + inputFiles
      if (config.outputFiles.length > inputCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputFiles'],
          message:
            'Number of output files must not be greater than the number of input files.',
        });
      }
    }
  }),
);

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
