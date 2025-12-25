/**
 * Agent lifecycle status - single source of truth for agent run state.
 */
const AGENT_LIFECYCLE_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  ERROR: 'error',
  COMPLETED: 'completed',
} as const;

type AgentLifecycleStatus =
  (typeof AGENT_LIFECYCLE_STATUS)[keyof typeof AGENT_LIFECYCLE_STATUS];

/**
 * State machine for agent lifecycle management.
 *
 * Core API:
 * - new AgentLifecycle(phase) - Create with initial phase
 * - lifecycle.begin(phase) - Begin phase with 'running' status
 * - lifecycle.setPhase(phase) - Set phase without changing status
 * - lifecycle.fail(error) - Set 'error' status with error
 * - lifecycle.complete() - Set 'completed' status
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
}
