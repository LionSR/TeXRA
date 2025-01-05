/**
 * Default settings for agent configuration
 */
export const DEFAULT_AGENT_SETTINGS: AgentSetting = {
  agentType: 'CoT',
  documentTag: 'document',
  temperature: 0.0,
  prefills: [],
  outputExt: 'txt',
  endTag: '\\end{document}',
  requiredFiles: {},
  requiredFilesInternal: {},
  defaultOutputFiles: [],
  filePatternsContain: [],
};

/**
 * Default prompts for agent configuration
 */
export const DEFAULT_AGENT_PROMPTS: AgentPrompt = {
  systemPrompt: '',
  userPrefix: '',
  userRequest: '',
  userReflect: '',
};

/**
 * Configuration for agent behavior and generation settings
 */
export interface AgentSetting {
  /** Core settings */
  agentType: 'CoT' | 'direct';
  documentTag: string;
  temperature: number | null;

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
 * Validates agent settings
 * @throws Error if settings are invalid
 */
export function validateAgentSetting(settings: AgentSetting): void {
  if (settings.agentType !== 'CoT' && settings.agentType !== 'direct') {
    throw new Error(
      `Invalid agentType: ${settings.agentType}. Must be 'CoT' or 'direct'`,
    );
  }

  if (
    settings.temperature !== null &&
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
 * Checks if file content contains the end tag or document tag
 */
export function hasEndTag(
  settings: AgentSetting,
  fileContent: string,
): boolean {
  return [
    settings.endTag,
    settings.documentTag && `</${settings.documentTag}>`,
    '\\end{document}',
  ].some((tag) => tag && fileContent.includes(tag));
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
