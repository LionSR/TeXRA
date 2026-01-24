// Third-party imports
import { z } from 'zod';

// Local imports - identifiers
import { ExecutionIdSchema } from './identifiers';

// Local imports - agent types
import { AgentCategory } from '@agent/core/AgentDataclass';

export const STREAM_STATUS = {
  RUNNING: 'running',
  ERROR: 'error',
  STOPPED: 'stopped',
  READY: 'ready',
  WAITING: 'waiting',
  RESUMING: 'resuming',
  INITIALIZING: 'initializing',
} as const;

export const StreamStatusSchema = z.enum([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.ERROR,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.READY,
  STREAM_STATUS.WAITING,
  STREAM_STATUS.RESUMING,
  STREAM_STATUS.INITIALIZING,
]);

export type StreamStatus = z.infer<typeof StreamStatusSchema>;

/**
 * Task group status - subset of StreamStatus used for task groups.
 * Single source of truth for TaskGroup.status in log schemas.
 */
export const TaskGroupStatusSchema = z.enum([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.ERROR,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.READY,
]);

export type TaskGroupStatus = z.infer<typeof TaskGroupStatusSchema>;

export const StreamUITraitsSchema = z.object({
  agentCategory: z.enum(AgentCategory),
  isToolAgent: z.boolean(),
});
export type StreamUITraits = z.infer<typeof StreamUITraitsSchema>;

export const StreamTabInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  model: z.string().optional(),
  agent: z.string().optional(),
  agentCategory: z.enum(AgentCategory),
  uiTraits: StreamUITraitsSchema,
  hasMultipleOutputs: z.boolean().optional(),
  isRemote: z.boolean().optional(),
  lastTimestamp: z.number().optional(),
  inputFile: z.string().optional(),
  creationTimestamp: z.number().optional(),
  status: z.string().optional(),
  executionId: ExecutionIdSchema.optional(),
});
export type StreamTabInfo = z.infer<typeof StreamTabInfoSchema>;
