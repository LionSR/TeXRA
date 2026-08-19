/**
 * Host-neutral interpretation of the follow-up plan and polish-result unions.
 *
 * The consumer of both unions is already shared
 * ({@link createProgressViewSecondTierHandlers}); only the switch that turns a
 * union member into host messaging had escaped into each host, once per host,
 * with no behavioural difference beyond the verb names of the notification
 * ports. Hosts now bind {@link FollowUpApplyPorts} and pass it here.
 */

// Local imports
import type { ExecutionRequest } from '@agent/core/state/executionRequests';
import type { ProgressViewOutboundMessage } from '@shared/schemas';
import type { ProgressFollowUpPlan } from './ProgressFollowUpController';
import type { ProgressFollowUpPolishResult } from './ProgressFollowUpPolishController';

/** Host messaging ports the two interpreters need. */
export interface FollowUpApplyPorts {
  readonly showInfo: (message: string) => Promise<void> | void;
  readonly showWarning: (message: string) => Promise<void> | void;
  readonly showError: (message: string) => Promise<void> | void;
  readonly logError: (message: string, error: Error | undefined) => void;
  readonly post: (message: ProgressViewOutboundMessage) => void;
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

/** Render a result from `ProgressFollowUpPolishController`. */
export async function applyFollowUpPolishResult(
  result: ProgressFollowUpPolishResult,
  ports: FollowUpApplyPorts,
): Promise<void> {
  if (result.kind === 'skipped') return;
  ports.post(result.update);
  if (result.kind === 'updated') return;
  if (result.kind === 'exception') {
    ports.logError(result.logMessage, result.logData);
  }
  await ports.showError(result.userMessage);
}
