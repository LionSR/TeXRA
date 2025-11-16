/**
 * Normalized tool call structure used across all model providers.
 * Each provider's ModelHandler normalizes its specific format to this common structure.
 */
export interface NormalizedToolCall {
  /**
   * Unique identifier for this tool call.
   * Required for correlating the call with its result.
   */
  callId: string;

  /**
   * Name of the tool being invoked.
   */
  name: string;

  /**
   * Parsed input parameters for the tool.
   * May be an object, primitive, or undefined depending on the tool.
   */
  input: unknown;

  /**
   * The original, provider-specific tool call object.
   * Preserved for use in createToolUseFollowUpMessages where
   * providers may need access to the original format.
   */
  rawCall: unknown;
}

/**
 * Result of tool call extraction from a provider response.
 */
export type ToolCallExtractionResult = NormalizedToolCall | null;
