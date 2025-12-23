import { z } from 'zod';

/**
 * Agent lifecycle status - single source of truth for agent run state.
 */
export const AGENT_LIFECYCLE_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  ERROR: 'error',
  COMPLETED: 'completed',
} as const;

export const AgentLifecycleStatusSchema = z.enum([
  AGENT_LIFECYCLE_STATUS.PENDING,
  AGENT_LIFECYCLE_STATUS.RUNNING,
  AGENT_LIFECYCLE_STATUS.ERROR,
  AGENT_LIFECYCLE_STATUS.COMPLETED,
]);

export type AgentLifecycleStatus = z.infer<typeof AgentLifecycleStatusSchema>;

/**
 * Schema for lifecycle snapshot - single source of truth.
 * Phase is a generic string to allow different phase enums per agent type.
 */
export const AgentLifecycleSnapshotSchema = z.object({
  phase: z.string(),
  status: AgentLifecycleStatusSchema,
  error: z.unknown().optional(),
});

/**
 * Snapshot for serialization - derived from schema.
 */
export type AgentLifecycleSnapshot<Phase extends string = string> = Omit<
  z.infer<typeof AgentLifecycleSnapshotSchema>,
  'phase'
> & { phase: Phase };

/**
 * State machine for agent lifecycle management.
 *
 * Replaces the 5 standalone lifecycle functions with a single class:
 * - createLifecycleState() → new AgentLifecycle(phase)
 * - beginLifecyclePhase() → lifecycle.begin(phase)
 * - setLifecyclePhase() → lifecycle.setPhase(phase)
 * - setLifecycleStatus() → lifecycle.setStatus(status)
 * - failLifecycle() → lifecycle.fail(error)
 * - completeLifecycle() → lifecycle.complete()
 *
 * @example
 * ```typescript
 * const lifecycle = new AgentLifecycle<'init' | 'run' | 'done'>('init');
 * lifecycle.begin('run');  // Sets phase='run', status='running'
 * lifecycle.fail(error);   // Sets status='error', stores error
 * lifecycle.complete();    // Sets status='completed'
 * ```
 */
export class AgentLifecycle<Phase extends string> {
  private _phase: Phase;
  private _status: AgentLifecycleStatus = AGENT_LIFECYCLE_STATUS.PENDING;
  private _error?: unknown;

  constructor(initialPhase: Phase) {
    this._phase = initialPhase;
  }

  /** Current phase of the lifecycle */
  get phase(): Phase {
    return this._phase;
  }

  /** Current status of the lifecycle */
  get status(): AgentLifecycleStatus {
    return this._status;
  }

  /** Error if status is 'error' */
  get error(): unknown {
    return this._error;
  }

  /**
   * Set phase without changing status.
   * Use this for phase-only transitions where status should remain unchanged.
   */
  setPhase(phase: Phase): void {
    this._phase = phase;
  }

  /**
   * Begin a new phase with 'running' status.
   * Clears any previous error.
   */
  begin(phase: Phase): void {
    this._phase = phase;
    this._status = AGENT_LIFECYCLE_STATUS.RUNNING;
    this._error = undefined;
  }

  /**
   * Set status directly.
   * Clears error if status is not 'error'.
   */
  setStatus(status: AgentLifecycleStatus): void {
    this._status = status;
    if (status !== AGENT_LIFECYCLE_STATUS.ERROR) {
      this._error = undefined;
    }
  }

  /**
   * Fail the lifecycle with an error.
   * Sets status to 'error' and stores the error.
   */
  fail(error: unknown): void {
    this._status = AGENT_LIFECYCLE_STATUS.ERROR;
    this._error = error;
  }

  /**
   * Complete the lifecycle successfully.
   * Sets status to 'completed' and clears any error.
   */
  complete(): void {
    this._status = AGENT_LIFECYCLE_STATUS.COMPLETED;
    this._error = undefined;
  }

  /**
   * Serialize to plain object for persistence.
   */
  toSnapshot(): AgentLifecycleSnapshot<Phase> {
    return {
      phase: this._phase,
      status: this._status,
      error: this._error,
    };
  }

  /**
   * Create from serialized snapshot with validation.
   * @throws {z.ZodError} if the snapshot data is invalid
   */
  static fromSnapshot<P extends string>(
    data: AgentLifecycleSnapshot<P>,
  ): AgentLifecycle<P> {
    // Validate the snapshot data
    const validated = AgentLifecycleSnapshotSchema.parse(data);
    const lifecycle = new AgentLifecycle(validated.phase as P);
    lifecycle._status = validated.status;
    lifecycle._error = validated.error;
    return lifecycle;
  }
}
