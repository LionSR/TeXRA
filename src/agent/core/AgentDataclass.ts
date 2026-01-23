// Third-party imports
import { z } from 'zod';

// Local imports - model types
import { ToolDefinitionSchema, type ToolDefinition } from '@model';
import * as logger from '@logger/logUtils';

const CHANNEL = 'AgentDataclass';

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
 * - Use `rounds: 1` for single-pass processing
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
  'never', // Never ensure XML structure
  'scratchpadOnly', // Only when useScratchpad is true (runtime default)
  'always', // Always ensure XML structure
]);
export type XmlStructureMode = z.infer<typeof XmlStructureMode>;

/** Workflow agents: document processing with fixed rounds. */
export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.Workflow)
    .prefault(AgentCategory.Workflow),
  isRewrite: z.boolean().prefault(true),
  /** Minimum rounds (default 2). Actual rounds = max(rounds, userRequest.length) */
  rounds: z.number().prefault(2),
  prefills: z.array(z.string()).prefault([]),
  outputExt: z.string().prefault('txt'),
  isMultipleOutput: z.boolean().prefault(false),

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
 * Handles backward compatibility for legacy fields:
 * - agentType: mapped to agentCategory, then stripped
 * - maxRounds: mapped to rounds, then stripped
 * Strips legacy fields before strictObject validation.
 * Defaults to Workflow when not specified.
 */
const normalizeAgentSettingInput = (input: unknown): unknown => {
  if (typeof input !== 'object' || input === null) {
    return input;
  }
  // Strip legacy fields via destructuring
  const { agentType, maxRounds, ...rest } = input as Record<string, unknown>;

  // Migrate maxRounds to rounds (if rounds not already set)
  if (maxRounds !== undefined && rest.rounds === undefined) {
    logger.debug(
      CHANNEL,
      `Migrating legacy maxRounds (${maxRounds}) to rounds`,
    );
    rest.rounds = maxRounds;
  }

  // If agentCategory already present, we're done
  if (rest.agentCategory !== undefined) {
    if (agentType !== undefined) {
      logger.debug(CHANNEL, `Stripping legacy agentType: ${agentType}`);
    }
    return rest;
  }

  // Backward compatibility: map legacy agentType: 'toolUse' to agentCategory
  if (agentType === 'toolUse') {
    logger.debug(
      CHANNEL,
      `Migrating legacy agentType: toolUse → AgentCategory.ToolUse`,
    );
    return { ...rest, agentCategory: AgentCategory.ToolUse };
  }

  if (agentType !== undefined) {
    logger.debug(
      CHANNEL,
      `Migrating legacy agentType: ${agentType} → AgentCategory.Workflow`,
    );
  }

  // Default to Workflow
  return { ...rest, agentCategory: AgentCategory.Workflow };
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
  if (settings.endTag && fileContent.includes(settings.endTag)) {
    return true;
  }
  const closingTag = settings.documentTag && `</${settings.documentTag}>`;
  return Boolean(closingTag && fileContent.includes(closingTag));
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
