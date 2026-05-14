import { z } from 'zod';

import { AgentCategorySchema } from './agent';
import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';

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

/** Subset of StreamStatus used for task groups */
export const TaskGroupStatusSchema = z.enum([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.ERROR,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.READY,
]);
export type TaskGroupStatus = z.infer<typeof TaskGroupStatusSchema>;

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

export const WORKTREE_PR_STATE = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
  DRAFT: 'draft',
} as const;

export const WorktreePRStateSchema = z.enum([
  WORKTREE_PR_STATE.OPEN,
  WORKTREE_PR_STATE.MERGED,
  WORKTREE_PR_STATE.CLOSED,
  WORKTREE_PR_STATE.DRAFT,
]);
export type WorktreePRState = z.infer<typeof WorktreePRStateSchema>;

export const WORKTREE_CI_STATE = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILURE: 'failure',
  UNKNOWN: 'unknown',
} as const;

export const WorktreeCIStateSchema = z.enum([
  WORKTREE_CI_STATE.PENDING,
  WORKTREE_CI_STATE.RUNNING,
  WORKTREE_CI_STATE.SUCCESS,
  WORKTREE_CI_STATE.FAILURE,
  WORKTREE_CI_STATE.UNKNOWN,
]);
export type WorktreeCIState = z.infer<typeof WorktreeCIStateSchema>;

export const WorktreePRInfoSchema = z.object({
  number: z.number(),
  state: WorktreePRStateSchema,
  title: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  ciState: WorktreeCIStateSchema.optional(),
});
export type WorktreePRInfo = z.infer<typeof WorktreePRInfoSchema>;

export const WorktreeInfoSchema = z.object({
  /** Absolute path of the worktree the agent is operating in. */
  workingDirectory: z.string(),
  /** Current HEAD branch, if checked out. */
  branch: z.string().optional(),
  /** True if the working tree has uncommitted changes. */
  dirty: z.boolean().optional(),
  /** Associated GitHub pull request, if one is known to exist. */
  pr: WorktreePRInfoSchema.optional(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;

export const StreamTabInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  model: z.string().optional(),
  modelLabel: z.string().optional(),
  agent: z.string().optional(),
  agentCategory: AgentCategorySchema,
  isRemote: z.boolean().optional(),
  inputFile: z.string().optional(),
  creationTimestamp: z.number(),
  executionId: ExecutionIdSchema.optional(),
  parentStreamId: StreamTabIdSchema.optional(),
  /** AI-generated summary of what this session aims to accomplish. */
  description: z.string().optional(),
  /** Full, untruncated command that spawned a process-agent stream (e.g. bash).
   * Set only for process streams; used by the process stream view. */
  command: z.string().optional(),
  /** Git worktree / PR context for streams whose agents operate in a
   * worktree other than the workspace root. Surfaced as a chip on the tab. */
  worktree: WorktreeInfoSchema.optional(),
});
export type StreamTabInfo = z.infer<typeof StreamTabInfoSchema>;
