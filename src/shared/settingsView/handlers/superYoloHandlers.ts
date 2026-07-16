/**
 * Multi-agent coordination ("super yolo") settings message builder.
 *
 * The outbound message carries reliability tuning, orchestrator-kill
 * permissions, and subagent-detach behaviour. Reliability settings are
 * host-specific (VS Code config-backed in the extension; absent in the
 * desktop build), so callers supply them.
 */
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import type { NumberVscodeSetting } from '@shared/schemas/profileViewMessages';
import type { UpdateSuperYoloEnabledMessage } from '@shared/schemas/settingsViewMessages';

import type { SettingsStatePorts } from '@shared/settingsView/types';

export interface SuperYoloHandlerPorts extends SettingsStatePorts {
  /** Host-provided reliability settings (extension only — desktop returns []). */
  readonly getReliabilitySettings: () => NumberVscodeSetting[];
}

export function buildSuperYoloMessage(
  ports: SuperYoloHandlerPorts,
): UpdateSuperYoloEnabledMessage {
  const { workspaceState } = ports;
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED,
    enabled: true,
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
