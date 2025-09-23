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
  /** Absolute directory containing the agent definition. */
  directory: string;
  /** Origin of the directory used to infer default agent metadata. */
  source: AgentDirectorySource;
}
