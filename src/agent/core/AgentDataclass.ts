// Third-party imports
import { z } from 'zod';

// Local imports - model types
import { ToolDefinitionSchema, type ToolDefinition } from '@model';

/** Temperature bounds for agent generation. */
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 1;

/** Where the agent definition comes from. */
export const AgentSource = z.enum([
  'custom',
  'builtIn',
  'builtInToolUse',
  'remote',
]);
export type AgentSource = z.infer<typeof AgentSource>;

/**
 * Primary discriminator for agent families.
 *
 * **Workflow**: Document processing agents that run for a fixed number of rounds.
 * - Default rounds: max(configured rounds, userRequest length)
 * - Use `maxRounds: 1` for single-pass processing
 * - XML structure enforcement controlled by `xmlStructureMode` (default: 'scratchpadOnly')
 *
 * **ToolUse**: Interactive agents with tool-calling capabilities.
 * - Continues until user follow-up or interruption
 * - Manages persistent sessions with checkpointing
 */
export enum AgentCategory {
  Workflow = 'workflow',
  ToolUse = 'toolUse',
}

/** Shared fields for all agent settings. */
export const AgentSettingBaseSchema = z.strictObject({
  documentTag: z
    .string()
    .min(1, 'documentTag cannot be empty')
    .prefault('document'),
  endTag: z.string().prefault('</latex_document>'),
  temperature: z
    .number()
    .min(MIN_TEMPERATURE)
    .max(MAX_TEMPERATURE)
    .nullable()
    .prefault(0.0),
  requiredFiles: z.record(z.string(), z.string()).prefault({}),
  requiredFilesInternal: z.record(z.string(), z.string()).prefault({}),
  defaultOutputFiles: z.array(z.string()).prefault([]),
  filePatternsContain: z
    .array(
      z.strictObject({
        pattern: z.string(),
        varName: z.string(),
        categories: z.array(z.string()).prefault([]),
      }),
    )
    .prefault([]),

  // ToolDefinition extends SerializableToolDefinition (schema output)
  tools: z.array(ToolDefinitionSchema).prefault([]),
});

/** XML structure enforcement modes for workflow agents. */
export const XmlStructureMode = z.enum([
  'never', // Never ensure XML structure (default)
  'scratchpadOnly', // Only when useScratchpad is true
  'always', // Always ensure XML structure
]);
export type XmlStructureMode = z.infer<typeof XmlStructureMode>;

/** Workflow agents: document processing with fixed rounds. */
export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.Workflow)
    .prefault(AgentCategory.Workflow),
  isRewrite: z.boolean().prefault(true),
  rounds: z.number().prefault(2),
  prefills: z.array(z.string()).prefault([]),
  outputExt: z.string().prefault('txt'),
  isMultipleOutput: z.boolean().prefault(false),

  /**
   * Maximum rounds to execute. When set, overrides the default calculation.
   * - undefined: Use max(rounds, userRequest.length) (default)
   * - 1: Single-pass processing
   * - N: Fixed number of rounds
   */
  maxRounds: z.number().optional(),

  /**
   * XML structure enforcement mode.
   * - 'scratchpadOnly': Only when prefills include scratchpad (default)
   * - 'always': Always ensure XML structure
   * - 'never': Don't ensure XML structure
   */
  xmlStructureMode: XmlStructureMode.optional(),
});

/** Tool-use agents: interactive agents with tool-calling capabilities. */
export const AgentToolUseSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.ToolUse)
    .prefault(AgentCategory.ToolUse),
});

/**
 * Normalize input to ensure agentCategory discriminator is present.
 * Defaults to Workflow when not specified.
 */
const normalizeAgentSettingInput = (input: unknown): unknown => {
  if (typeof input !== 'object' || input === null) {
    return input;
  }
  const obj = input as Record<string, unknown>;
  if (obj.agentCategory !== undefined) {
    return input;
  }
  return {
    ...obj,
    agentCategory: AgentCategory.Workflow,
  };
};

/**
 * Union schema with preprocessing to normalize discriminator.
 * Uses discriminatedUnion for O(1) lookup and better error messages.
 */
export const AgentSettingSchema = z.preprocess(
  normalizeAgentSettingInput,
  z.discriminatedUnion('agentCategory', [
    AgentWorkflowSettingSchema,
    AgentToolUseSettingSchema,
  ]),
);

export type AgentSetting = z.infer<typeof AgentSettingSchema>;
export type AgentWorkflowSetting = Extract<
  AgentSetting,
  { agentCategory: AgentCategory.Workflow }
>;
export type AgentToolUseSetting = Extract<
  AgentSetting,
  { agentCategory: AgentCategory.ToolUse }
>;

/** Type guard for workflow settings. */
export function isWorkflowSetting(
  setting: AgentSetting,
): setting is AgentWorkflowSetting {
  return setting.agentCategory === AgentCategory.Workflow;
}

/** Narrow to workflow setting or throw. */
export function requireWorkflowSetting(
  setting: AgentSetting,
): AgentWorkflowSetting {
  if (!isWorkflowSetting(setting)) {
    throw new Error(
      'Expected workflow agent settings but received tool-use settings.',
    );
  }
  return setting;
}

/**
 * Checks if content contains a valid end marker.
 */
export function hasEndTag(
  settings: AgentSetting,
  fileContent: string,
): boolean {
  const endTagLists = [
    settings.endTag,
    settings.documentTag && `</${settings.documentTag}>`,
  ];
  return endTagLists.some((tag) => tag && fileContent.includes(tag));
}

/** Zod schema for AgentPrompt validation */
const promptEntrySchema = z.union([z.string(), z.array(z.string())]);

export const AgentPromptSchema = z.strictObject({
  systemPrompt: z.string().prefault(''),
  userPrefix: z.string().prefault(''),
  userRequest: promptEntrySchema.prefault(''),
  userReflect: z.string().optional(),
});

export type AgentPrompt = z.infer<typeof AgentPromptSchema>;

const DefinitionBlockSchema = z.record(z.string(), z.unknown()).prefault({});

export const AgentDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  inherits: z.string().optional(),
  settings: DefinitionBlockSchema,
  prompts: DefinitionBlockSchema,
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** Parses a settings block into an AgentSetting. */
export function parseAgentSetting(settings: unknown): AgentSetting {
  return AgentSettingSchema.parse(settings);
}
