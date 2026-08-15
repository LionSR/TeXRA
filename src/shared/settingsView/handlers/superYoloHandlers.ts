/**
 * Reliability-and-orchestration settings message builder.
 *
 * The outbound wire command remains `updateSuperYoloEnabled` for compatibility;
 * the payload is reliability tuning, orchestrator-kill permissions, and
 * subagent-detach behaviour — not a TeXRA approval-policy value.
 *
 * Reliability settings are host-specific (VS Code config-backed in the
 * extension; absent in the desktop build), so callers supply them.
 */
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  NumberSetting,
  UpdateReliabilityAndOrchestrationMessage,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

import type { SettingsStatePorts } from '@shared/settingsView/types';

export interface ReliabilityAndOrchestrationHandlerPorts extends SettingsStatePorts {
  /** Host-provided reliability settings (extension only — desktop returns []). */
  readonly getReliabilitySettings: () => NumberSetting[];
}

export function buildReliabilityAndOrchestrationMessage(
  ports: ReliabilityAndOrchestrationHandlerPorts,
): UpdateReliabilityAndOrchestrationMessage {
  const { workspaceState } = ports;
  return {
    // Compatibility-pinned wire literal — see settingsView/data.ts.
    command: SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED,
    reliabilitySettings: ports.getReliabilitySettings(),
    allowOrchestratorKill: workspaceState.get<boolean>(
      WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
      true,
    ),
    detachSubagentsOnStop: workspaceState.get<boolean>(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    ),
  };
}
