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
export enum AgentSessionKind {
  Workflow = 'workflow',
  ToolUse = 'toolUse',
}

/**
 * Shared metadata describing how an agent session should be classified.
 */
export interface AgentSessionMetadata {
  /** Specific agent implementation type if known. */
  agentType?: AgentType;
  /** Canonical grouping used by the UI to filter sessions. */
  agentSessionKind: AgentSessionKind;
}

/**
 * Derive the canonical {@link AgentSessionKind} from a specific agent type.
 * Defaults to {@link AgentSessionKind.Workflow} when the type is unknown.
 */
export function deriveAgentSessionKind(
  agentType?: AgentType | null,
): AgentSessionKind {
  return agentType === AgentType.ToolUse
    ? AgentSessionKind.ToolUse
    : AgentSessionKind.Workflow;
}

/**
 * Resolve canonical session metadata from optional hints.
 */
export function resolveAgentSessionMetadata(
  agentType?: AgentType | null,
  sessionKindHint?: AgentSessionKind | null,
): AgentSessionMetadata {
  const agentSessionKind = sessionKindHint ?? deriveAgentSessionKind(agentType);
  return {
    agentType: agentType ?? undefined,
    agentSessionKind,
  };
}

/**
 * Base schema shared by workflow and tool-use agent settings. Individual
 * variants extend this schema to add variant-specific constraints.
 */
export const AgentSettingBaseSchema = z
  .object({
    agentType: z.nativeEnum(AgentType).default(AgentType.CoT),
    documentTag: z
      .string()
      .min(1, 'documentTag cannot be empty')
      .default('document'),
    temperature: z
      .number()
      .min(MIN_TEMPERATURE)
      .max(MAX_TEMPERATURE)
      .nullable()
      .default(0.0),
    isRewrite: z.boolean().default(true),

    rounds: z.number().default(2),
    prefills: z.array(z.string()).default([]),
    outputExt: z.string().default('txt'),
    endTag: z.string().default('</latex_document>'),

    requiredFiles: z.record(z.string()).default({}),
    requiredFilesInternal: z.record(z.string()).default({}),
    defaultOutputFiles: z.array(z.string()).default([]),
    useMultipleOutputs: z.boolean().default(false),
    filePatternsContain: z
      .array(
        z.object({
          pattern: z.string(),
          varName: z.string(),
          categories: z.array(z.string()).default([]),
        }),
      )
      .default([]),

    tools: z.array(ToolDefinitionSchema).default([]),
  })
  .strict();

/**
 * Workflow agent settings support multiple-output workflows and therefore
 * expose the {@code isMultipleOutput} toggle.
 */
export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  isMultipleOutput: z.boolean().default(false),
}).superRefine((data, ctx) => {
  if (data.agentType === AgentType.ToolUse) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agentType'],
      message:
        'Workflow agent settings cannot use the toolUse agent type. Use the tool-use schema instead.',
    });
  }
});

/** Tool-use agents never expose workflow-specific flags. */
export const AgentToolUseSettingSchema = AgentSettingBaseSchema.extend({
  agentType: z.literal(AgentType.ToolUse).default(AgentType.ToolUse),
  isMultipleOutput: z.literal(false).default(false),
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
export const AgentPromptSchema = z
  .object({
    systemPrompt: z.string().default(''),
    userPrefix: z.string().default(''),
    userRequest: z.string().default(''),
    userReflect: z.union([z.string(), z.array(z.string())]).default(''),
  })
  .strict();

export type AgentPrompt = z.infer<typeof AgentPromptSchema>;

/**
 * Schema representing the full agent YAML definition.
 * Includes the root name, optional inheritance target,
 * settings block and prompt configuration.
 */
export const AgentDefinitionSchema = z
  .object({
    name: z.string().trim().min(1),
    inherits: z.string().optional(),
    settings: z.record(z.unknown()).optional(),
    prompts: z.record(z.unknown()).optional(),
  })
  .strict();

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
