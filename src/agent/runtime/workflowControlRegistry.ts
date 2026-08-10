/**
 * `WorkflowControlRegistry` — a session-scoped map from a live workflow-script
 * run to that run's engine control handle.
 *
 * Both sides speak one identity: the host UI targets a run's `agent()`
 * grandchild by its execution id (the same identity the child list, focus, and
 * kill use), and {@link WorkflowScriptControl} takes that id directly. The
 * registry fans a request out to every registered run, so the one run that
 * currently owns that grandchild acts and the rest no-op — the same
 * no-op-if-not-in-flight semantics the engine already guarantees.
 *
 * Host-agnostic and session-owned: registration happens in the workflow-script
 * strategy (`src/tools/delegation`), consumption in a host (the CLI child list).
 */

import type {
  WorkflowControlAction,
  WorkflowScriptControl,
} from '@agent/workflowScript';
import type { ExecutionId } from '@shared/schemas';

/** Session-owned map of live workflow runs to their control handles. */
export class WorkflowControlRegistry {
  private readonly runs = new Map<ExecutionId, WorkflowScriptControl>();

  /**
   * Register a run's control handle under its run execution id. Returns a
   * disposer that removes exactly this registration (identity-checked so a
   * relaunch under the same id cannot tear out the fresh entry).
   */
  register(
    runExecutionId: ExecutionId,
    control: WorkflowScriptControl,
  ): () => void {
    this.runs.set(runExecutionId, control);
    return () => {
      if (this.runs.get(runExecutionId) === control) {
        this.runs.delete(runExecutionId);
      }
    };
  }

  /**
   * Skip or retry the in-flight grandchild `agent()` call with this execution
   * id. No-op if no live run owns it.
   */
  control(grandchildId: ExecutionId, action: WorkflowControlAction): void {
    for (const control of this.runs.values()) control(grandchildId, action);
  }
}
