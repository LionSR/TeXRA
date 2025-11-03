// Local imports - agent runtime types

/**
 * Indicates which directory contributed an agent definition.
 */
export enum AgentDirectorySource {
  /** User-provided agents located in the custom directory. */
  Custom = 'custom',
  /** Built-in workflow agents bundled with the extension. */
  BuiltIn = 'builtIn',
  /** Built-in tool-use agents bundled with the extension. */
  BuiltInToolUse = 'builtInToolUse',
}

/**
 * Result of resolving an agent name to a directory on disk.
 */
export interface AgentPathResolution {
  /** Absolute directory containing the resolved agent definition. */
  directory: string;
  /** Origin of the directory used to infer default agent metadata. */
  source: AgentDirectorySource;
  /** Absolute path to the YAML definition that was selected. */
  definitionPath: string;
  /** Basename of the YAML definition without extension. */
  resolvedName: string;
  /** Indicates whether resolving required falling back from a preferred variant. */
  usedFallback: boolean;
}
