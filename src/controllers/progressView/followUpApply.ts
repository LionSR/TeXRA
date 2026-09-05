/**
 * Host-neutral interpretation of the follow-up plan union: the switch that
 * turns a plan into host messaging or a launch, bound once per host through
 * {@link FollowUpApplyPorts}.
 */

// Local imports
import type { ExecutionRequest } from '@agent/core/state/executionRequests';
import type { ProgressFollowUpPlan } from './ProgressFollowUpController';

/** Host messaging ports the two interpreters need. */
export interface FollowUpApplyPorts {
  readonly showInfo: (message: string) => Promise<void> | void;
  readonly showWarning: (message: string) => Promise<void> | void;
  readonly showError: (message: string) => Promise<void> | void;
  readonly logError: (message: string, error: Error | undefined) => void;
  /**
   * Run a compile-fixer request. Follow-up `execute` plans are only ever the
   * compile fixer (latexFixer), so both hosts run them on the configured
   * helper model.
   */
  readonly runCompileFixer: (request: ExecutionRequest) => Promise<void>;
}

/** Carry out a plan from `ProgressFollowUpController`. */
export async function applyFollowUpPlan(
  plan: ProgressFollowUpPlan,
  ports: FollowUpApplyPorts,
): Promise<void> {
  switch (plan.kind) {
    case 'warning':
      await ports.showWarning(plan.message);
      return;
    case 'info':
      await ports.showInfo(plan.message);
      return;
    case 'execute':
      await ports.runCompileFixer(plan.request);
  }
}
