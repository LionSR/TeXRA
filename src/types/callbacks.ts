/**
 * Callback interfaces for dependency injection.
 *
 * This module is part of the @types/ layer - the foundation that all other
 * layers can import from without creating circular dependencies.
 *
 * These interfaces allow the agent system to be decoupled from:
 * - UI functions (VS Code dialogs, notifications)
 * - Secret management (API keys)
 * - File system operations specific to the extension host
 *
 * The command layer provides implementations; the agent layer accepts interfaces.
 */

/**
 * Interface for secret/API key management.
 * Allows agent and model layers to access secrets without depending on @frontend.
 */
export interface ISecretProvider {
  /**
   * Get an API key for a specific provider.
   * @param provider - The provider identifier (e.g., 'anthropic', 'openai')
   * @returns The API key if available, undefined otherwise
   */
  getApiKey(provider: string): Promise<string | undefined>;

  /**
   * Check if an API key exists for a provider.
   * @param provider - The provider identifier
   * @returns True if the key exists
   */
  hasApiKey?(provider: string): Promise<boolean>;
}

/**
 * Interface for UI callbacks during agent execution.
 * Allows agent layer to trigger UI operations without depending on @frontend.
 */
export interface IAgentUICallbacks {
  /**
   * Show an instruction message to the user with suppression option.
   * @param key - Unique key for tracking suppression preference
   * @param message - The message to display
   * @returns True if the user acknowledged, false if suppressed
   */
  showInstruction(key: string, message: string): Promise<boolean>;

  /**
   * Open build display for a TeX file if applicable.
   * @param filePath - Path to the file
   */
  openBuildDisplay(filePath: string): Promise<void>;

  /**
   * Show an error message to the user.
   * @param message - The error message
   * @param options - Optional action buttons
   * @returns The selected action or undefined
   */
  showError(message: string, options?: string[]): Promise<string | undefined>;

  /**
   * Show an information message to the user.
   * @param message - The info message
   */
  showInfo?(message: string): Promise<void>;
}

/**
 * Interface for agent directory management.
 * Allows agent registry to be initialized without depending on @frontend.
 */
export interface IAgentDirectories {
  /**
   * Get path to built-in workflow agents.
   */
  builtIn(): Promise<string>;

  /**
   * Get path to built-in tool-use agents.
   */
  builtInToolUse(): Promise<string>;

  /**
   * Get path to custom user agents.
   */
  custom(): Promise<string>;
}

/**
 * Combined execution context for agent runs.
 * Aggregates all injected dependencies.
 */
export interface IAgentExecutionContext {
  /** Secret provider for API keys */
  secrets: ISecretProvider;
  /** UI callbacks for user interaction */
  ui: IAgentUICallbacks;
  /** Optional: Agent directories for registry initialization */
  directories?: IAgentDirectories;
}
