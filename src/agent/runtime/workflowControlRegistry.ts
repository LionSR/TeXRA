/**
 * `WorkflowControlRegistry` — the session-scoped set of engine control handles
 * of the live workflow-script runs.
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

import type { WorkflowScriptControl } from '@agent/workflowScript';
import type { ExecutionId, WorkflowControlAction } from '@shared/schemas';

/** Session-owned set of the control handles of live workflow runs. */
export class WorkflowControlRegistry {
  private readonly runs = new Set<WorkflowScriptControl>();

  /**
   * Register a run's control handle. Returns a disposer that removes exactly
   * this handle, so a relaunched run's fresh registration survives the old
   * run's teardown. Each run's control is a distinct closure, so two live runs
   * coexist here and both see every request — which is what fan-out already
   * assumes.
   */
  register(control: WorkflowScriptControl): () => void {
    this.runs.add(control);
    return () => {
      this.runs.delete(control);
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
