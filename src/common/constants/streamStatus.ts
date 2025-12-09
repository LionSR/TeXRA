/**
 * Stream status constants shared across agent runtime and UI layers.
 */
import { z } from 'zod';

export const STREAM_STATUS = {
  RUNNING: 'running',
  ERROR: 'error',
  STOPPED: 'stopped',
  READY: 'ready',
  WAITING: 'waiting',
  RESUMING: 'resuming',
} as const;

export const StreamStatusSchema = z.enum([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.ERROR,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.READY,
  STREAM_STATUS.WAITING,
  STREAM_STATUS.RESUMING,
]);

export type StreamStatus = z.infer<typeof StreamStatusSchema>;

/**
 * Task group status - subset of StreamStatus used for task groups.
 * Single source of truth for TaskGroup.status in LogTypes.ts and eventBus/schemas.ts.
 */
export const TaskGroupStatusSchema = z.enum([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.ERROR,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.READY,
]);

export type TaskGroupStatus = z.infer<typeof TaskGroupStatusSchema>;
