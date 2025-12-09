// Third-party imports
import { z } from 'zod';

// Local imports - model types
import { ToolDefinitionSchema } from '@model';

// Local imports - session schema (imported for local use, re-exported below)
import type { AgentSessionDescriptor } from './AgentSessionSchema';

/** Temperature bounds for agent generation. */
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 1;

/** Enum defining possible agent types */
export enum AgentType {
  CoT = 'CoT',
  Direct = 'direct',
  ToolUse = 'toolUse',
}

/**
 * Canonical session categories used throughout the extension UI.
 * Workflow sessions represent traditional direct/CoT executions while
 * toolUse isolates interactive tool panels.
 */
export enum AgentCategory {
  Workflow = 'workflow',
  ToolUse = 'toolUse',
}

// Re-export AgentSessionDescriptor from schema (single source of truth)
// Note: The type is derived from AgentSessionDescriptorSchema in AgentSessionSchema.ts
export type { AgentSessionDescriptor } from './AgentSessionSchema';

/**
 * Derive the canonical {@link AgentCategory} from a specific agent type.
 * Defaults to {@link AgentCategory.Workflow} when the type is unknown.
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

/** Shared fields for all agent settings (discriminator added per-variant). */
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

  tools: z.array(ToolDefinitionSchema).prefault([]),
});

/** Workflow agents: only CoT/Direct types, adds workflow-specific fields. */
export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  agentType: z.enum([AgentType.CoT, AgentType.Direct]).prefault(AgentType.CoT),
  agentCategory: z.literal(AgentCategory.Workflow).prefault(AgentCategory.Workflow),
  isRewrite: z.boolean().prefault(true),
  rounds: z.number().prefault(2),
  prefills: z.array(z.string()).prefault([]),
  outputExt: z.string().prefault('txt'),
  isMultipleOutput: z.boolean().prefault(false),
});

/** Tool-use agents: forces ToolUse type, no workflow fields. */
export const AgentToolUseSettingSchema = AgentSettingBaseSchema.extend({
  agentType: z.literal(AgentType.ToolUse).prefault(AgentType.ToolUse),
  agentCategory: z.literal(AgentCategory.ToolUse).prefault(AgentCategory.ToolUse),
});

/**
 * Union schema - tries workflow first, then tool-use.
 * Note: z.union (not discriminatedUnion) because input may lack agentCategory.
 */
export const AgentSettingSchema = z.union([
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
]);

/** Canonical union type - derive subtypes via Extract for type safety. */
export type AgentSetting = z.infer<typeof AgentSettingSchema>;
export type AgentWorkflowSetting = Extract<AgentSetting, { agentCategory: AgentCategory.Workflow }>;
export type AgentToolUseSetting = Extract<AgentSetting, { agentCategory: AgentCategory.ToolUse }>;

/**
 * Return the canonical session descriptor for a fully-materialized agent setting.
 */
export function getAgentSessionDescriptor(
  setting: AgentSetting,
): Required<AgentSessionDescriptor> {
  return {
    agentType: setting.agentType,
    agentCategory: setting.agentCategory,
  };
}

/** Narrow an {@link AgentSetting} to the workflow variant. */
export function requireWorkflowSetting(
  setting: AgentSetting,
): AgentWorkflowSetting {
  if (setting.agentType === AgentType.ToolUse) {
    throw new Error(
      'Expected workflow agent settings but received tool-use settings.',
    );
  }
  return setting;
}

/** Default prompt templates for agent interactions. */

/**
 * Checks if content contains a valid end marker.
 * @returns True if content contains endTag, document closing tag, or LaTeX document end
 */
export function hasEndTag(
  settings: AgentSetting,
  fileContent: string,
): boolean {
  const endTagLists = [
    settings.endTag,
    settings.documentTag && `</${settings.documentTag}>`,
  ];

  // if (settings.agentType === AgentType.CoT){
  //   endTagLists.push('\\end{document}');
  // }
  // this is not correct for multiple documents
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

/**
 * Schema representing the full agent YAML definition.
 * Includes the root name, optional inheritance target,
 * settings block and prompt configuration.
 */
const DefinitionBlockSchema = z.record(z.string(), z.unknown()).prefault({});

export const AgentDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  inherits: z.string().optional(),
  settings: DefinitionBlockSchema,
  prompts: DefinitionBlockSchema,
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** Parses a settings block into an {@link AgentSetting}. */
export function parseAgentSetting(settings: unknown): AgentSetting {
  return AgentSettingSchema.parse(settings);
}
