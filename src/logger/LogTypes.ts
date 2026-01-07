/**
 * Shared logging interfaces used by the logger and progress view.
 * Defines Zod schemas as single source of truth, derives TypeScript types.
 */
import { z } from 'zod';

import { TaskGroupStatusSchema } from '@common/constants/streamStatus';

// Local imports - schemas for composition
import { LogLevelSchema, MessageTypeSchema } from './messageTypes';

/**
 * Task group schema - single source of truth for task group structure.
 * Used by logger and progress view for tracking execution groups.
 */
export const TaskGroupSchema = z.strictObject({
  /** Unique identifier for the group */
  id: z.string().min(1),
  /** Display name of the group */
  name: z.string(),
  /** Unix timestamp (ms) when the group started */
  startTime: z.number(),
  /** Unix timestamp (ms) when the group ended */
  endTime: z.number().optional(),
  /** Current status of the group */
  status: TaskGroupStatusSchema,
  /** Parent group ID for nested groups */
  parentGroupId: z.string().optional(),
  /** Model identifier (enriched from taskState) */
  model: z.string().optional(),
  /** Agent identifier (enriched from taskState) */
  agent: z.string().optional(),
});

export type TaskGroup = z.infer<typeof TaskGroupSchema>;

/**
 * Log message data schema - single source of truth for log entry structure.
 */
export const LogMessageDataSchema = z.strictObject({
  /** Unique identifier for this log entry */
  id: z.string().min(1),
  /** Raw message text */
  text: z.string(),
  /** Severity level */
  level: LogLevelSchema,
  /** Unix timestamp (ms) */
  timestamp: z.number(),
  /** Optional group association */
  groupId: z.string().optional(),
  /** Optional message category */
  messageType: MessageTypeSchema.optional(),
  /** Whether verbose details should be displayed */
  verbose: z.boolean().optional(),
  /** Optional structured data associated with the entry */
  data: z.unknown().optional(),
});

export type LogMessageData = z.infer<typeof LogMessageDataSchema>;

/**
 * Log message update schema - partial update for existing log entries.
 * All fields optional except id (required for identifying the entry to update).
 */
export const LogMessageUpdateSchema = LogMessageDataSchema.partial().required({
  id: true,
});

export type LogMessageUpdate = z.infer<typeof LogMessageUpdateSchema>;
