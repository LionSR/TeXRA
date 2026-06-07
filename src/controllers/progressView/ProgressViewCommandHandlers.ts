// Local imports - shared
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';

// Local imports - controllers
import {
  createProgressViewApprovalCommandHandlers,
  type ProgressViewApprovalCommandActions,
} from './ProgressViewApprovalCommandHandlers';
import {
  createProgressViewBypassCommandHandlers,
  type ProgressViewBypassCommandOptions,
} from './ProgressViewBypassCommandHandlers';
import {
  createProgressViewFileCommandHandlers,
  type ProgressViewFileCommandActions,
} from './ProgressViewFileCommandHandlers';
import {
  createProgressViewFollowUpCommandHandlers,
  type ProgressViewFollowUpCommandActions,
} from './ProgressViewFollowUpCommandHandlers';
import {
  createProgressViewLifecycleCommandHandlers,
  type ProgressViewLifecycleCommandActions,
} from './ProgressViewLifecycleCommandHandlers';
import {
  createProgressViewRunCommandHandlers,
  type ProgressViewRunCommandActions,
} from './ProgressViewRunCommandHandlers';

export interface ProgressViewCommandActions {
  lifecycle: ProgressViewLifecycleCommandActions;
  run: ProgressViewRunCommandActions;
  followUp: ProgressViewFollowUpCommandActions;
  bypass: ProgressViewBypassCommandOptions;
  file: ProgressViewFileCommandActions;
  approval: ProgressViewApprovalCommandActions;
}

/**
 * Shared progress-view command groups used by both extension and desktop.
 *
 * Host-only commands stay with each host; this factory owns the command groups
 * whose routing should not drift across hosts.
 */
export function createProgressViewCommandHandlers(
  actions: ProgressViewCommandActions,
): ProgressViewInboundHandlerRegistry {
  return {
    ...createProgressViewLifecycleCommandHandlers(actions.lifecycle),
    ...createProgressViewRunCommandHandlers(actions.run),
    ...createProgressViewFollowUpCommandHandlers(actions.followUp),
    ...createProgressViewBypassCommandHandlers(actions.bypass),
    ...createProgressViewFileCommandHandlers(actions.file),
    ...createProgressViewApprovalCommandHandlers(actions.approval),
  };
}
