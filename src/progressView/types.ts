export interface StreamTabInfo {
  /** Unique stream identifier */
  name: string;
  /** Agent YAML name */
  agentName?: string;
  /** Input file basename */
  inputFile?: string;
  /** Model used for execution */
  model?: string;
  /** Agent type such as 'CoT' or 'direct' */
  agentType?: string;
  /** True if more than one output file */
  hasMultipleOutputs?: boolean;
  /** Timestamp of the most recent log message */
  lastTimestamp?: number;
}
