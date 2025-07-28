export interface StreamTabInfo {
  name: string;
  /** Short label displayed in the tab UI */
  label: string;
  model?: string;
  agent?: string;
  agentType?: string;
  hasMultipleOutputs?: boolean;
  lastTimestamp?: number;
  inputFile?: string;
  creationTimestamp?: number;
}
