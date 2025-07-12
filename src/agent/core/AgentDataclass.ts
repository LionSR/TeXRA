// Local imports - model types
import type { ToolDefinition } from '@model';
import { z } from 'zod';

/** Enum defining possible agent types */
export enum AgentType {
  CoT = 'CoT',
  Direct = 'direct',
  ToolUse = 'toolUse',
}

/** Zod schema for ToolDefinition validation */
export const ToolDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  })
  .strict();

/** Zod schema for AgentSetting validation */
export const AgentSettingSchema = z
  .object({
    agentType: z.nativeEnum(AgentType),
    documentTag: z.string().min(1, 'documentTag cannot be empty'),
    temperature: z.number().min(0).max(1).nullable(),
    isRewrite: z.boolean(),

    rounds: z.number().optional(),
    prefills: z.array(z.string()),
    outputExt: z.string(),
    endTag: z.string(),

    requiredFiles: z.record(z.string()),
    requiredFilesInternal: z.record(z.string()),
    defaultOutputFiles: z.array(z.string()),
    filePatternsContain: z.array(z.record(z.string())),

    tools: z.array(ToolDefinitionSchema).optional(),
  })
  .strict();

/** Base configuration for agent behavior with default values. */
export const DEFAULT_AGENT_SETTINGS: AgentSetting = {
  agentType: AgentType.CoT,
  documentTag: 'document',
  temperature: 0.0,
  rounds: 2,
  prefills: [],
  outputExt: 'txt',
  endTag: '</latex_document>',
  requiredFiles: {},
  requiredFilesInternal: {},
  defaultOutputFiles: [],
  filePatternsContain: [],
  tools: undefined,
  isRewrite: true,
};

/** Default prompt templates for agent interactions. */
export const DEFAULT_AGENT_PROMPTS: AgentPrompt = {
  systemPrompt: '',
  userPrefix: '',
  userRequest: '',
  userReflect: '',
};

/** Configuration interface defining agent behavior and generation parameters. */
export interface AgentSetting {
  /** Core settings */
  agentType: AgentType;
  documentTag: string;
  temperature: number | null;
  isRewrite: boolean;

  /** Number of conversation rounds to run. */
  rounds?: number;

  /** Generation settings */
  prefills: string[];
  outputExt: string;
  endTag: string;

  /** File configurations */
  requiredFiles: Record<string, string>;
  requiredFilesInternal: Record<string, string>;
  defaultOutputFiles: string[];
  filePatternsContain: Array<Record<string, string>>;

  /** Tool definitions available to the agent */
  tools?: ToolDefinition[];
}

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

/**
 * Configuration for agent prompts
 */
export interface AgentPrompt {
  systemPrompt: string;
  userPrefix: string;
  userRequest: string;
  userReflect: string;
}
