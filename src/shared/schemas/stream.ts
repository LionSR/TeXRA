// Third-party imports
import { z } from 'zod';

// Local imports
import { AgentCategorySchema } from './agent';
import { ExecutionIdSchema } from './identifiers';

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
 * Single source of truth for TaskGroup.status.
 */
export const TaskGroupStatusSchema = z.enum([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.ERROR,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.READY,
]);
export type TaskGroupStatus = z.infer<typeof TaskGroupStatusSchema>;

// ============================================================================
// Execution Status - Flow-Level Completion Status
// ============================================================================

export const EXECUTION_STATUS = {
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  ERROR: 'error',
} as const;

export const ExecutionStatusSchema = z.enum([
  EXECUTION_STATUS.COMPLETED,
  EXECUTION_STATUS.INTERRUPTED,
  EXECUTION_STATUS.ERROR,
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

// ============================================================================
// Progress view stream metadata
// ============================================================================

export const StreamTabInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  model: z.string().optional(),
  agent: z.string().optional(),
  agentCategory: AgentCategorySchema,
  hasMultipleOutputs: z.boolean().optional(),
  isRemote: z.boolean().optional(),
  lastTimestamp: z.number().optional(),
  inputFile: z.string().optional(),
  creationTimestamp: z.number().optional(),
  status: z.string().optional(),
  executionId: ExecutionIdSchema.optional(),
});
export type StreamTabInfo = z.infer<typeof StreamTabInfoSchema>;

export const InstructionMetadataSchema = z.object({
  showToggle: z.boolean().optional(),
});
export type InstructionMetadata = z.infer<typeof InstructionMetadataSchema>;

export const InstructionUpdateSchema = z.object({
  text: z.string(),
  metadata: InstructionMetadataSchema.optional(),
  /** Timestamp when the instruction was submitted (epoch milliseconds) */
  timestamp: z.number().optional(),
});
export type InstructionUpdate = z.infer<typeof InstructionUpdateSchema>;
