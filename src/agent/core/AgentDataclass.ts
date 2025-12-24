// Third-party imports
import { z } from 'zod';

// Local imports - model types
import { ToolDefinitionSchema, type ToolDefinition } from '@model';

// Local imports - session schema (imported for local use, re-exported below)
import type { AgentSessionDescriptor } from './AgentSessionSchema';

/** Temperature bounds for agent generation. */
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 1;

/** Primary discriminator for agent families. */
export enum AgentCategory {
  Workflow = 'workflow',
  ToolUse = 'toolUse',
}

/** Further differentiator within each category. */
export enum AgentType {
  CoT = 'CoT',
  Direct = 'direct',
  ToolUse = 'toolUse',
}

// Re-export AgentSessionDescriptor from schema (single source of truth)
export type { AgentSessionDescriptor } from './AgentSessionSchema';

/**
 * Derive AgentCategory from AgentType.
 */
export function deriveAgentCategory(
  agentType?: AgentType | null,
): AgentCategory {
  return agentType === AgentType.ToolUse
    ? AgentCategory.ToolUse
    : AgentCategory.Workflow;
}

/**
 * Resolve canonical session metadata from optional hints.
 */
export function resolveAgentSessionDescriptor(
  agentType?: AgentType | null,
  categoryHint?: AgentCategory | null,
): AgentSessionDescriptor {
  const agentCategory = categoryHint ?? deriveAgentCategory(agentType);
  return {
    agentType: agentType ?? undefined,
    agentCategory,
  };
}

/** Shared fields for all agent settings. */
export const AgentSettingBaseSchema = z.strictObject({
  agentType: z.enum(AgentType).prefault(AgentType.CoT),
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
  tools: z
    .array(
      z.custom<ToolDefinition>(
        (val) => ToolDefinitionSchema.safeParse(val).success,
      ),
    )
    .prefault([]),
});

/** Workflow agents: CoT or Direct patterns with workflow-specific fields. */
export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.Workflow)
    .prefault(AgentCategory.Workflow),
  agentType: z.enum([AgentType.CoT, AgentType.Direct]).prefault(AgentType.CoT),
  isRewrite: z.boolean().prefault(true),
  rounds: z.number().prefault(2),
  prefills: z.array(z.string()).prefault([]),
  outputExt: z.string().prefault('txt'),
  isMultipleOutput: z.boolean().prefault(false),
});

/** Tool-use agents: interactive agents with tool-calling capabilities. */
export const AgentToolUseSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.ToolUse)
    .prefault(AgentCategory.ToolUse),
  agentType: z.literal(AgentType.ToolUse).prefault(AgentType.ToolUse),
});

/**
 * Union schema for agent settings.
 * Uses z.union (not discriminatedUnion) for backward compatibility.
 */
export const AgentSettingSchema = z.union([
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
]);

export type AgentSetting = z.infer<typeof AgentSettingSchema>;
export type AgentWorkflowSetting = Extract<
  AgentSetting,
  { agentCategory: AgentCategory.Workflow }
>;
export type AgentToolUseSetting = Extract<
  AgentSetting,
  { agentCategory: AgentCategory.ToolUse }
>;

/**
 * Return the canonical session descriptor for an agent setting.
 */
export function getAgentSessionDescriptor(
  setting: AgentSetting,
): Required<AgentSessionDescriptor> {
  return {
    agentType: setting.agentType,
    agentCategory: setting.agentCategory,
  };
}

/** Narrow to workflow setting or throw. */
export function requireWorkflowSetting(
  setting: AgentSetting,
): AgentWorkflowSetting {
  if (setting.agentCategory === AgentCategory.ToolUse) {
    throw new Error(
      'Expected workflow agent settings but received tool-use settings.',
    );
  }
  return setting as AgentWorkflowSetting;
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
