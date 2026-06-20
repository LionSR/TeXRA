/**
 * Multi-agent coordination ("super yolo") settings message builder.
 *
 * The outbound message carries reliability tuning, orchestrator-kill
 * permissions, subagent-detach behaviour, and the nested-delegation depth
 * cap. Reliability settings are host-specific (VS Code config-backed in the
 * extension; absent in the desktop build), so callers supply them.
 */
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc/settingsViewCommands';
import {
  NESTED_DELEGATION_DEPTH_RANGE,
  clampNestedDelegationDepth,
} from '@shared/constants/delegationPolicy';
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
    nestedDelegationMaxDepth: clampNestedDelegationDepth(
      workspaceState.get<number>(
        WorkspaceStateKey.NESTED_DELEGATION_MAX_DEPTH,
        NESTED_DELEGATION_DEPTH_RANGE.default,
      ),
    ),
  };
}

/**
 * Persists the nested-delegation depth cap. Centralizes the clamp invariant and
 * the backing {@link WorkspaceStateKey} so the extension (VS Code) and desktop
 * (Electron) hosts can't drift on either. Callers refresh their own
 * webview/renderer afterwards (the refresh transport is host-specific).
 */
export async function setNestedDelegationMaxDepth(
  ports: SettingsStatePorts,
  value: number,
): Promise<void> {
  await ports.workspaceState.update(
    WorkspaceStateKey.NESTED_DELEGATION_MAX_DEPTH,
    clampNestedDelegationDepth(value),
  );
}
