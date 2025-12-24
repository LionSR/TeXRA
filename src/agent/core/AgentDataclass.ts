// Third-party imports
import { z } from 'zod';

// Local imports - model types
import { ToolDefinitionSchema, type ToolDefinition } from '@model';

// Local imports - session schema (imported for local use, re-exported below)
import type { AgentSessionDescriptor } from './AgentSessionSchema';

/** Temperature bounds for agent generation. */
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 1;

// ============================================================================
// AGENT CATEGORY - Primary discriminator for agent families
// ============================================================================

/**
 * Canonical session categories used throughout the extension UI.
 * This is the PRIMARY discriminator for agent types.
 *
 * - Workflow: Traditional document processing agents (CoT, Direct patterns)
 * - ToolUse: Interactive tool-calling agents with session persistence
 */
export enum AgentCategory {
  Workflow = 'workflow',
  ToolUse = 'toolUse',
}

// ============================================================================
// WORKFLOW PATTERNS - Execution patterns within the Workflow category
// ============================================================================

/**
 * Execution patterns for workflow agents.
 * These define HOW a workflow agent processes documents.
 *
 * - MultiRound (CoT): Multi-step reasoning with reflection rounds
 * - SingleRound (Direct): Single-pass document processing
 */
export const WorkflowPattern = {
  /** Chain-of-Thought: Multi-round reasoning with XML structure */
  MultiRound: 'CoT',
  /** Direct: Single-round processing */
  SingleRound: 'direct',
} as const;

export type WorkflowPatternType =
  (typeof WorkflowPattern)[keyof typeof WorkflowPattern];

/** Zod schema for workflow pattern validation */
export const WorkflowPatternSchema = z.enum([
  WorkflowPattern.MultiRound,
  WorkflowPattern.SingleRound,
]);

// ============================================================================
// AGENT TYPE - Legacy enum, kept for backward compatibility
// ============================================================================

/**
 * Enum defining possible agent types.
 *
 * @deprecated Use `AgentCategory` as the primary discriminator.
 * For workflow agents, use `WorkflowPattern` to distinguish CoT vs Direct.
 * This enum is maintained for backward compatibility with existing code
 * and YAML configurations.
 *
 * Mapping:
 * - AgentType.CoT → AgentCategory.Workflow + WorkflowPattern.MultiRound
 * - AgentType.Direct → AgentCategory.Workflow + WorkflowPattern.SingleRound
 * - AgentType.ToolUse → AgentCategory.ToolUse (no pattern needed)
 */
export enum AgentType {
  CoT = 'CoT',
  Direct = 'direct',
  ToolUse = 'toolUse',
}

// Re-export AgentSessionDescriptor from schema (single source of truth)
// Note: The type is derived from AgentSessionDescriptorSchema in AgentSessionSchema.ts
export type { AgentSessionDescriptor } from './AgentSessionSchema';

// ============================================================================
// CATEGORY & TYPE UTILITIES
// ============================================================================

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
 * Check if an agent type represents a workflow agent.
 * Workflow agents use document processing patterns (CoT or Direct).
 */
export function isWorkflowType(agentType?: AgentType | null): boolean {
  return (
    agentType === AgentType.CoT ||
    agentType === AgentType.Direct ||
    agentType === undefined ||
    agentType === null
  );
}

/**
 * Check if an agent type represents a tool-use agent.
 */
export function isToolUseType(agentType?: AgentType | null): boolean {
  return agentType === AgentType.ToolUse;
}

/**
 * Get the workflow pattern from an agent type.
 * Returns undefined for tool-use agents.
 */
export function getWorkflowPattern(
  agentType?: AgentType | null,
): WorkflowPatternType | undefined {
  if (agentType === AgentType.CoT) return WorkflowPattern.MultiRound;
  if (agentType === AgentType.Direct) return WorkflowPattern.SingleRound;
  return undefined;
}

/**
 * Derive the legacy AgentType from category and pattern.
 * Useful for backward compatibility when constructing settings.
 */
export function deriveAgentType(
  category: AgentCategory,
  pattern?: WorkflowPatternType,
): AgentType {
  if (category === AgentCategory.ToolUse) {
    return AgentType.ToolUse;
  }
  // Default to CoT for workflow agents if pattern not specified
  return pattern === WorkflowPattern.SingleRound
    ? AgentType.Direct
    : AgentType.CoT;
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

  // Use custom validator that validates via schema but preserves ToolDefinition type
  // This bridges the gap between schema validation and TypeScript typing
  tools: z
    .array(
      z.custom<ToolDefinition>(
        (val) => ToolDefinitionSchema.safeParse(val).success,
      ),
    )
    .prefault([]),
});

// ============================================================================
// CATEGORY-SPECIFIC SETTING SCHEMAS
// ============================================================================

/**
 * Workflow agents: Document processing agents with CoT or Direct patterns.
 *
 * Schema includes:
 * - agentCategory: Always 'workflow' (discriminator)
 * - agentType: 'CoT' or 'direct' (legacy, derived from workflowPattern)
 * - workflowPattern: Canonical pattern identifier
 * - Workflow-specific fields: rounds, prefills, outputExt, etc.
 */
export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.Workflow)
    .prefault(AgentCategory.Workflow),
  // Legacy field - kept for backward compatibility with YAML configs
  agentType: z.enum([AgentType.CoT, AgentType.Direct]).prefault(AgentType.CoT),
  // New canonical pattern field (optional for backward compat, derived from agentType if missing)
  workflowPattern: WorkflowPatternSchema.optional(),
  isRewrite: z.boolean().prefault(true),
  rounds: z.number().prefault(2),
  prefills: z.array(z.string()).prefault([]),
  outputExt: z.string().prefault('txt'),
  isMultipleOutput: z.boolean().prefault(false),
});

/**
 * Tool-use agents: Interactive agents with tool-calling capabilities.
 *
 * Schema includes:
 * - agentCategory: Always 'toolUse' (discriminator)
 * - agentType: Always 'toolUse' (legacy, redundant with category)
 * - No workflow-specific fields (rounds, prefills, etc.)
 */
export const AgentToolUseSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.ToolUse)
    .prefault(AgentCategory.ToolUse),
  // Legacy field - always 'toolUse' for this category
  agentType: z.literal(AgentType.ToolUse).prefault(AgentType.ToolUse),
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
export type AgentWorkflowSetting = Extract<
  AgentSetting,
  { agentCategory: AgentCategory.Workflow }
>;
export type AgentToolUseSetting = Extract<
  AgentSetting,
  { agentCategory: AgentCategory.ToolUse }
>;

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

/**
 * Narrow an {@link AgentSetting} to the workflow variant.
 * Uses agentCategory as the primary discriminator.
 */
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
 * Narrow an {@link AgentSetting} to the tool-use variant.
 * Uses agentCategory as the primary discriminator.
 */
export function requireToolUseSetting(
  setting: AgentSetting,
): AgentToolUseSetting {
  if (setting.agentCategory === AgentCategory.Workflow) {
    throw new Error(
      'Expected tool-use agent settings but received workflow settings.',
    );
  }
  return setting as AgentToolUseSetting;
}

/**
 * Type guard to check if a setting is for a workflow agent.
 */
export function isWorkflowSetting(
  setting: AgentSetting,
): setting is AgentWorkflowSetting {
  return setting.agentCategory === AgentCategory.Workflow;
}

/**
 * Type guard to check if a setting is for a tool-use agent.
 */
export function isToolUseSetting(
  setting: AgentSetting,
): setting is AgentToolUseSetting {
  return setting.agentCategory === AgentCategory.ToolUse;
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
