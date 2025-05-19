/** Enum defining possible agent types */
export enum AgentType {
  CoT = 'CoT',
  Direct = 'direct',
}

/** Base configuration for agent behavior with default values. */
export const DEFAULT_AGENT_SETTINGS: AgentSetting = {
  agentType: AgentType.CoT,
  documentTag: 'document',
  temperature: 0.0,
  prefills: [],
  outputExt: 'txt',
  endTag: '</latex_document>',
  requiredFiles: {},
  requiredFilesInternal: {},
  defaultOutputFiles: [],
  filePatternsContain: [],
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

  /** Generation settings */
  prefills: string[];
  outputExt: string;
  endTag: string;

  /** File configurations */
  requiredFiles: Record<string, string>;
  requiredFilesInternal: Record<string, string>;
  defaultOutputFiles: string[];
  filePatternsContain: Array<Record<string, string>>;
}

/**
 * Validates agent settings for correctness and completeness.
 * @throws Error if agentType is invalid, temperature is out of range, or documentTag is empty
 */
export function validateAgentSetting(settings: AgentSetting): void {
  if (
    settings.agentType !== AgentType.CoT &&
    settings.agentType !== AgentType.Direct
  ) {
    throw new Error(
      `Invalid agentType: ${settings.agentType}. Must be '${AgentType.CoT}' or '${AgentType.Direct}'`,
    );
  }

  if (
    settings.temperature != null &&
    (settings.temperature < 0.0 || settings.temperature > 1.0)
  ) {
    throw new Error(
      `Temperature must be between 0.0 and 1.0, got ${settings.temperature}`,
    );
  }

  if (!settings.documentTag) {
    throw new Error('documentTag cannot be empty');
  }
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
