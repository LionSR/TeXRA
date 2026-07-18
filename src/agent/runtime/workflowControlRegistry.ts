/**
 * `WorkflowControlRegistry` — a session-scoped bridge from a workflow-script
 * grandchild's execution id to that run's engine control handle (skip/retry by
 * call index).
 *
 * The workflow engine's control (see {@link WorkflowScriptControl}) is keyed by
 * an engine-internal call *index*; the host UI targets a run's `agent()`
 * grandchild by its *execution id* (the same identity the child list, focus,
 * and kill use). Each in-flight workflow run registers a {@link WorkflowRunControl}
 * that translates its own live grandchild execution ids into engine indices;
 * the registry fans a skip/retry request out to every registered run, so the
 * one run that currently owns that grandchild acts and the rest no-op — the
 * same no-op-if-not-in-flight semantics the engine already guarantees.
 *
 * Host-agnostic and session-owned: registration happens in the workflow-script
 * strategy (`src/tools/delegation`), consumption in a host (the CLI child list).
 */

// Local imports - shared schemas
import type { ExecutionId } from '@shared/schemas';

/**
 * One in-flight workflow run's control surface, keyed by the execution id of
 * its live `agent()` grandchildren. Both actions no-op when `grandchildId` is
 * not a currently in-flight grandchild of this run.
 */
export interface WorkflowRunControl {
  /** Cancel the in-flight grandchild `agent()` call as a deliberate skip. */
  skip(grandchildId: ExecutionId): void;
  /** Cancel and re-run the in-flight grandchild `agent()` call as a fresh attempt. */
  retry(grandchildId: ExecutionId): void;
}

/** Session-owned map of live workflow runs to their control handles. */
export class WorkflowControlRegistry {
  private readonly runs = new Map<ExecutionId, WorkflowRunControl>();

  /**
   * Register a run's control handle under its run execution id. Returns a
   * disposer that removes exactly this registration (identity-checked so a
   * relaunch under the same id cannot tear out the fresh entry).
   */
  register(
    runExecutionId: ExecutionId,
    control: WorkflowRunControl,
  ): () => void {
    this.runs.set(runExecutionId, control);
    return () => {
      if (this.runs.get(runExecutionId) === control) {
        this.runs.delete(runExecutionId);
      }
    };
  }

  /** Skip the in-flight grandchild `agent()` call with this execution id. No-op if none owns it. */
  skip(grandchildId: ExecutionId): void {
    for (const control of this.runs.values()) control.skip(grandchildId);
  }

  /** Retry the in-flight grandchild `agent()` call with this execution id. No-op if none owns it. */
  retry(grandchildId: ExecutionId): void {
    for (const control of this.runs.values()) control.retry(grandchildId);
  }
}
