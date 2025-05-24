/**
 * Token usage statistics for tracking model usage and costs.
 */
export interface TokenUsageStats {
  /** Number of input tokens consumed */
  inputTokens: number;
  /** Number of output tokens generated */
  outputTokens: number;
  /** Total cost in USD for the request */
  cost: number;
}

/**
 * Message interface for updating usage stats in the progress view.
 */
export interface StreamUsageMessage {
  command: 'updateUsage';
  usage: TokenUsageStats | undefined;
}