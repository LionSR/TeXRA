/**
 * Shared agent-related types used across the codebase.
 *
 * This module is part of the @types/ layer - the foundation that all other
 * layers can import from without creating circular dependencies.
 */
import { z } from 'zod';

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
 * Session descriptor for agent execution context.
 */
export const AgentSessionDescriptorSchema = z.strictObject({
  agentType: z.nativeEnum(AgentType).optional(),
  agentCategory: z.nativeEnum(AgentCategory),
});
export type AgentSessionDescriptor = z.infer<
  typeof AgentSessionDescriptorSchema
>;

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
