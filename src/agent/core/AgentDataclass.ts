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

/** Zod schema for AgentSetting validation */
export const AgentSettingSchema = z
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

    requiredFiles: z.record(z.string(), z.string()).default({}),
    requiredFilesInternal: z.record(z.string(), z.string()).default({}),
    defaultOutputFiles: z.array(z.string()).default([]),
    useMultipleOutputs: z.boolean().default(false),
    filePatternsContain: z
      .array(
        z
          .object({
            pattern: z.string(),
            varName: z.string(),
            categories: z.array(z.string()).default([]),
          })
          .strip(),
      )
      .default([]),

    tools: z.array(ToolDefinitionSchema).default([]),
  })
  .strip();

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
  .strip();

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
    settings: z.record(z.string(), z.unknown()).optional(),
    prompts: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
