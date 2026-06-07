// Local imports - shared
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';
import {
  isApprovalBypassedForStream,
  proposalApprovalState,
  setBashApprovalSessionBypass,
  setToolEditApprovalSessionBypass,
  toggleToolEditApprovalSessionBypass,
} from '@tools/approval';

export interface ProgressViewBypassCommandOptions {
  runtimeHost: AgentRuntimeHost;
  showInfo?(message: string): void | PromiseLike<unknown>;
}

/**
 * Shared policy for progress-view bypass toggles.
 *
 * The UI exposes one shield for file edits + bash and one stronger delegated
 * task auto-approval. Keep the cross-approval side effects here so hosts do
 * not each reimplement the same symmetry rules.
 */
export function createProgressViewBypassCommandHandlers(
  options: ProgressViewBypassCommandOptions,
): ProgressViewInboundHandlerRegistry {
  const { runtimeHost, showInfo } = options;

  return {
    [PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS]: async (data) => {
      const isNowEnabled = toggleToolEditApprovalSessionBypass(
        data.stream,
        runtimeHost,
      );
      setBashApprovalSessionBypass(data.stream, isNowEnabled, runtimeHost, {
        silent: true,
      });
      await showInfo?.(
        isNowEnabled
          ? 'YOLO mode enabled: Tool actions and bash commands will be auto-approved for this stream.'
          : 'YOLO mode disabled: Tool actions and bash commands will prompt for approval.',
      );
    },
    [PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS]: async (data) => {
      const isNowEnabled = proposalApprovalState.toggleBypass(
        data.stream,
        runtimeHost,
      );
      if (isNowEnabled) {
        if (!isApprovalBypassedForStream(data.stream)) {
          setToolEditApprovalSessionBypass(data.stream, true, runtimeHost);
        }
      } else {
        setToolEditApprovalSessionBypass(data.stream, false, runtimeHost);
      }
      setBashApprovalSessionBypass(data.stream, isNowEnabled, runtimeHost, {
        silent: true,
      });
      await showInfo?.(
        isNowEnabled
          ? 'Delegated task auto-approval enabled for this stream.'
          : 'Delegated task auto-approval disabled for this stream.',
      );
    },
  };
}
