import { Effect } from 'effect';
import type { StateStore, StateReadFailed } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
/**
 * Agent selection / custom-directory / mode-preset outbound message builders.
 *
 * Both graphical hosts share these wire shapes. State reads remain Effects
 * in the host program; no controller-specific forwarding ports are needed.
 */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentModePreset, ByCategory } from '@shared/schemas';
import type {
  AgentScanIssue,
  AgentSelectionItem,
  UpdateAgentModePresetsMessage,
  UpdateAgentSelectionMessage,
  UpdateCustomAgentDirMessage,
} from '@shared/settingsView/settingsViewMessages';

export interface AgentSelectionPorts {
  buildSelectionItems(): Effect.Effect<
    ByCategory<AgentSelectionItem[]>,
    StateReadFailed
  >;
  getCustomAgentScanIssues(): readonly AgentScanIssue[];
}

export function buildAgentSelectionMessage(ports: AgentSelectionPorts) {
  return Effect.gen(function* () {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      agents: yield* ports.buildSelectionItems(),
      customAgentIssues: [...ports.getCustomAgentScanIssues()],
    };
  });
}

export function buildCustomAgentDirMessage<E, R = never>(
  globalState: StateStore,
  customDir: Effect.Effect<string, E, R>,
): Effect.Effect<UpdateCustomAgentDirMessage, E | StateReadFailed, R> {
  return Effect.gen(function* () {
    const configuredPath = yield* globalState.get<string>(
      GlobalStateKey.CUSTOM_AGENT_DIR,
      '',
    );
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
      path: yield* customDir,
      isDefault: (configuredPath?.trim() ?? '') === '',
    };
  });
}

export interface AgentModePresetsPorts {
  getCustomPresets(): Effect.Effect<AgentModePreset[], StateReadFailed>;
  getOrchestratorAgentNames(): string[];
  getActiveTeamId(): Effect.Effect<string | null, StateReadFailed>;
}

export function buildAgentModePresetsMessage(ports: AgentModePresetsPorts) {
  return Effect.gen(function* () {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
      customPresets: yield* ports.getCustomPresets(),
      orchestratorAgents: ports.getOrchestratorAgentNames(),
      activePresetId: yield* ports.getActiveTeamId(),
    };
  });
}
