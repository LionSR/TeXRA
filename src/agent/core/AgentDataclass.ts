// Third-party imports
import { z } from 'zod';

// Local imports - agent
// Local imports - model types
import { ToolDefinitionSchema } from '@model';

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
 * Canonical session groupings used throughout the extension UI.
 * Workflow sessions represent traditional direct/CoT executions while
 * toolUse isolates interactive tool panels.
 */
export const AgentCategorySchema = z.enum(['workflow', 'toolUse'] as const);

export type AgentCategory = z.infer<typeof AgentCategorySchema>;

/**
 * Shared metadata describing how an agent session should be classified.
 */
export interface AgentSessionMetadata {
  /** Specific agent implementation type if known. */
  agentType?: AgentType;
  /** Canonical grouping used by the UI to filter sessions. */
  agentCategory: AgentCategory;
}

/**
 * Derive the canonical {@link AgentCategory} from a specific agent type.
 * Defaults to {@code workflow} when the type is unknown.
 */
export function deriveAgentCategory(
  agentType?: AgentType | null,
): AgentCategory {
  return agentType === AgentType.ToolUse ? 'toolUse' : 'workflow';
}

/**
 * Base schema shared by workflow and tool-use agent settings. Individual
 * variants extend this schema to add variant-specific constraints.
 */
export const AgentSettingBaseSchema = z.strictObject({
  agentType: z.enum(AgentType).prefault(AgentType.CoT),
  agentCategory: AgentCategorySchema.optional(),
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

/**
 * Workflow agent settings support multiple-output workflows and therefore
 * expose the {@code isMultipleOutput} toggle.
 */
export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  isRewrite: z.boolean().prefault(true),
  rounds: z.number().prefault(2),
  prefills: z.array(z.string()).prefault([]),
  outputExt: z.string().prefault('txt'),
  isMultipleOutput: z.boolean().prefault(false),
  agentCategory: z.literal('workflow').prefault('workflow'),
}).superRefine((data, ctx) => {
  if (data.agentType === AgentType.ToolUse) {
    ctx.addIssue({
      code: 'custom',
      path: ['agentType'],
      message:
        'Workflow agent settings cannot use the toolUse agent type. Use the tool-use schema instead.',
    });
  }
});

/** Tool-use agents never expose workflow-specific flags. */
export const AgentToolUseSettingSchema = AgentSettingBaseSchema.extend({
  agentType: z.literal(AgentType.ToolUse).prefault(AgentType.ToolUse),
  agentCategory: z.literal('toolUse').prefault('toolUse'),
});

/**
 * Canonical agent settings schema combining workflow and tool-use variants.
 */
export const AgentSettingSchema = z.union([
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
]);

export type AgentWorkflowSetting = z.infer<typeof AgentWorkflowSettingSchema>;
export type AgentToolUseSetting = z.infer<typeof AgentToolUseSettingSchema>;
export type AgentSetting = z.infer<typeof AgentSettingSchema>;

/** Resolve the canonical agent category from validated settings. */
export function getAgentCategory(setting: AgentSetting): AgentCategory {
  const agentType = (setting as { agentType?: AgentType }).agentType;
  return setting.agentCategory ?? deriveAgentCategory(agentType);
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
export const AgentPromptSchema = z.strictObject({
  systemPrompt: z.string().prefault(''),
  userPrefix: z.string().prefault(''),
  userRequest: z.string().prefault(''),
  userReflect: z.union([z.string(), z.array(z.string())]).prefault(''),
});

export type AgentPrompt = z.infer<typeof AgentPromptSchema>;

/**
 * Schema representing the full agent YAML definition.
 * Includes the root name, optional inheritance target,
 * settings block and prompt configuration.
 */
export const AgentDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1),
  inherits: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  prompts: z.record(z.string(), z.unknown()).optional(),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** Parses a settings block into an {@link AgentSetting}. */
export function parseAgentSetting(settings: unknown): AgentSetting {
  return AgentSettingSchema.parse(settings ?? {});
}
