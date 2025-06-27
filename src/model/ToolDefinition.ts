/**
 * Generic description of a tool/function that a provider can execute.
 * Fields beyond `name` are provider specific.
 */
export interface ToolDefinition {
  /** Name of the tool or function */
  name: string;
  /** Optional description for the model */
  description?: string;
  /** Parameter schema or provider specific metadata */
  parameters?: Record<string, unknown>;
  /** Additional provider-specific fields */
  [key: string]: unknown;
}
