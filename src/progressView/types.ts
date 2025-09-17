export interface StreamTabInfo {
  name: string;
  /** Short label displayed in the tab UI */
  label: string;
  /** Primary title for the tab (agent name). */
  primaryLabel: string;
  /** Secondary subtitle (file name or session). */
  secondaryLabel?: string;
  model?: string;
  agent?: string;
  agentType?: string;
  category: 'workflow' | 'toolUse';
  hasMultipleOutputs?: boolean;
  lastTimestamp?: number;
  inputFile?: string;
  creationTimestamp?: number;
  status?: string;
}
