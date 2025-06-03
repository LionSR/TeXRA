/**
 * Shared logging interfaces used by the logger and progress view.
 */

import type { TokenUsageStats } from './UsageTypes';

export interface LogGroup {
  /** Unique identifier for the group */
  id: string;
  /** Display name of the group */
  name: string;
  /** Unix timestamp (ms) when the group started */
  startTime: number;
  /** Unix timestamp (ms) when the group ended */
  endTime?: number;
  /** Current status of the group */
  status: 'running' | 'error' | 'stopped' | 'ready';
  /** Parent group ID for nested groups */
  parentGroupId?: string;
  /** Optional usage stats attached to the group */
  usage?: TokenUsageStats;
}
